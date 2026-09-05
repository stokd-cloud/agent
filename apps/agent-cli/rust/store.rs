use crate::types::*;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

pub struct Store {
    db: Mutex<Connection>,
    root: PathBuf,
}

impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root.join("locks"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        }
        let db = Connection::open(root.join("agent.sqlite3"))?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, identity TEXT NOT NULL, remit TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), title TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS events(conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(conversation_id,seq));
            CREATE TABLE IF NOT EXISTS messages(conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(conversation_id,seq));
            CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), state TEXT NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', prompt_bytes INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
            CREATE UNIQUE INDEX IF NOT EXISTS one_running_turn ON turns(conversation_id) WHERE state='running';
            CREATE TABLE IF NOT EXISTS summaries(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), through_seq INTEGER NOT NULL, content TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), content TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, source_seq INTEGER NOT NULL DEFAULT 0, forgotten INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, UNIQUE(agent_id,content));
            CREATE TABLE IF NOT EXISTS memory_changes(id INTEGER PRIMARY KEY, memory_id TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), title TEXT NOT NULL, content TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), title TEXT NOT NULL, status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), action TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
            CREATE TABLE IF NOT EXISTS imports(source TEXT PRIMARY KEY);
            PRAGMA user_version=1;
        ")?;
        Ok(Self {
            db: Mutex::new(db),
            root: root.to_path_buf(),
        })
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Database lock poisoned"))?;
        f(&db)
    }

    pub fn transaction<T>(&self, f: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Database lock poisoned"))?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    /// An OS lock fences processes and is released even after SIGKILL.
    pub fn lock_conversation(&self, conversation: &str) -> Result<File> {
        ensure!(
            conversation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "Invalid conversation ID"
        );
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("locks").join(conversation))?;
        file.try_lock_exclusive()
            .context("Conversation is running in another process")?;
        Ok(file)
    }

    pub fn agent(&self, name: &str) -> Result<Agent> {
        self.with(|db| {
            db.query_row(
                "SELECT id,name,identity,remit FROM agents WHERE name=?1 OR id=?1",
                [name],
                |r| {
                    Ok(Agent {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        identity: r.get(2)?,
                        remit: r.get(3)?,
                    })
                },
            )
            .optional()?
            .context("Agent not found; use stokd-agent create <name> or import-poc")
        })
    }

    pub fn conversation(&self, agent: &Agent, conversation: &str) -> Result<Conversation> {
        self.with(|db| db.query_row("SELECT id,agent_id,title,cursor,updated_at FROM conversations WHERE id=?1 AND agent_id=?2", params![conversation,agent.id], conversation_row).optional()?.context("Conversation not found for this agent"))
    }

    pub fn conversations(&self, agent: &Agent) -> Result<Vec<Conversation>> {
        self.with(|db| Ok(db.prepare("SELECT id,agent_id,title,cursor,updated_at FROM conversations WHERE agent_id=?1 ORDER BY updated_at DESC,id LIMIT 200")?.query_map([&agent.id], conversation_row)?.collect::<rusqlite::Result<_>>()?))
    }

    pub fn create_conversation(&self, agent: &Agent, title: &str) -> Result<Conversation> {
        let conversation = Conversation {
            id: id("cnv"),
            agent_id: agent.id.clone(),
            title: title.chars().take(160).collect(),
            cursor: 0,
            updated_at: now(),
        };
        self.with(|db| {
            db.execute(
                "INSERT INTO conversations(id,agent_id,title,updated_at) VALUES(?1,?2,?3,?4)",
                params![
                    conversation.id,
                    agent.id,
                    conversation.title,
                    conversation.updated_at
                ],
            )?;
            Ok(())
        })?;
        Ok(conversation)
    }

    pub fn replay(&self, conversation: &str, after: i64, limit: i64) -> Result<Vec<Event>> {
        self.with(|db| {
            let mut stmt = db.prepare("SELECT seq,kind,data,created_at FROM events WHERE conversation_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
            let rows = stmt.query_map(params![conversation,after,limit.clamp(1,200)], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?)))?;
            rows.map(|r| {let (seq,kind,data,created_at) = r?; Ok(Event { conversation_id:conversation.into(),seq,kind,data:serde_json::from_str(&data)?,created_at })}).collect()
        })
    }

    pub fn messages(&self, conversation: &str, before: i64, limit: i64) -> Result<Vec<Message>> {
        self.with(|db| {
            let mut stmt = db.prepare("SELECT seq,role,content,turn_id FROM messages WHERE conversation_id=?1 AND seq<?2 ORDER BY seq DESC LIMIT ?3")?;
            let mut rows = stmt.query_map(params![conversation,before,limit.clamp(1,120)], |r| Ok(Message{seq:r.get(0)?,role:r.get(1)?,content:r.get(2)?,turn_id:r.get(3)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows.reverse(); Ok(rows)
        })
    }

    pub fn summary(&self, conversation: &str) -> Result<Summary> {
        self.with(|db| {
            Ok(db
                .query_row(
                    "SELECT through_seq,content FROM summaries WHERE conversation_id=?1",
                    [conversation],
                    |r| {
                        Ok(Summary {
                            through_seq: r.get(0)?,
                            content: r.get(1)?,
                        })
                    },
                )
                .optional()?
                .unwrap_or_default())
        })
    }

    pub fn memories(&self, agent: &str) -> Result<Vec<Memory>> {
        self.with(|db| Ok(db.prepare("SELECT id,content,revision,source_seq FROM memories WHERE agent_id=?1 AND forgotten=0 ORDER BY rowid DESC")?.query_map([agent], |r| Ok(Memory{id:r.get(0)?,content:r.get(1)?,revision:r.get(2)?,source_seq:r.get(3)?}))?.collect::<rusqlite::Result<_>>()?))
    }

    pub fn turn_live(&self, turn: &str) -> Result<bool> {
        self.with(|db| {
            Ok(db
                .query_row(
                    "SELECT state='running' FROM turns WHERE id=?1",
                    [turn],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(false))
        })
    }

    pub fn recover(&self, conversation: &str) -> Result<()> {
        if let Ok(_guard) = self.lock_conversation(conversation) {
            self.transaction(|tx| {
                let turn: Option<String> = tx.query_row("SELECT id FROM turns WHERE conversation_id=?1 AND state='running'",[conversation],|r| r.get(0)).optional()?;
                if let Some(turn) = turn {
                    tx.execute("UPDATE turns SET state='interrupted',stage='interrupted',error='Engine stopped before completion' WHERE id=?1",[&turn])?;
                    append_event(tx,conversation,"turn.interrupted",json!({"turnId":turn,"reason":"Engine stopped before completion"}))?;
                }
                Ok(())
            })?;
        }
        Ok(())
    }
}

pub fn conversation_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        agent_id: r.get(1)?,
        title: r.get(2)?,
        cursor: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

/// Must only run inside the same transaction as the fact it announces.
pub fn append_event(
    tx: &Transaction<'_>,
    conversation: &str,
    kind: &str,
    data: Value,
) -> Result<i64> {
    let seq: i64 = tx.query_row(
        "UPDATE conversations SET cursor=cursor+1,updated_at=?2 WHERE id=?1 RETURNING cursor",
        params![conversation, now()],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO events VALUES(?1,?2,?3,?4,?5)",
        params![
            conversation,
            seq,
            kind,
            serde_json::to_string(&data)?,
            now()
        ],
    )?;
    Ok(seq)
}

pub fn append_message(
    tx: &Transaction<'_>,
    conversation: &str,
    turn: &str,
    role: &str,
    content: &str,
) -> Result<i64> {
    let seq = append_event(
        tx,
        conversation,
        "message.committed",
        json!({"role":role,"content":content,"turnId":turn}),
    )?;
    tx.execute(
        "INSERT INTO messages VALUES(?1,?2,?3,?4,?5)",
        params![conversation, seq, role, content, turn],
    )?;
    Ok(seq)
}
