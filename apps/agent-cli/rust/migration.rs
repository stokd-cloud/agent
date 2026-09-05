//! One transactional, idempotent import of the Mongo PoC. Source collections
//! are read by the migration adapter and are never updated or deleted.
use crate::{
    Engine,
    store::{append_event, append_message},
    types::{normalize, now, text},
};
use anyhow::{Context, Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

impl Engine {
    pub fn import_poc(&self, p: &Value) -> Result<Value> {
        let source = text(p, "source")?;
        let data = &p["data"];
        let array = |name: &str| {
            data[name]
                .as_array()
                .with_context(|| format!("Missing PoC {name} array"))
        };
        let agents = array("agents")?;
        let conversations = array("conversations")?;
        let messages = array("messages")?;
        let memories = array("memories")?;
        let summaries = array("summaries")?;
        self.store.transaction(|tx| {
            let imported:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM imports WHERE source=?1)",[source],|r|r.get(0))?;
            if imported {return Ok(json!({"alreadyImported":true}));}
            for a in agents {
                let name = normalize(text(a,"name")?)?;
                tx.execute("INSERT INTO agents VALUES(?1,?2,?3,'')",params![text(a,"_id")?,name,text(a,"identity")?]).context("PoC agent collides with an existing agent; import into an empty STOKD_AGENT_HOME")?;
            }
            for c in conversations {
                tx.execute("INSERT INTO conversations(id,agent_id,title,updated_at) VALUES(?1,?2,?3,?4)",params![text(c,"_id")?,text(c,"agentId")?,c["title"].as_str().unwrap_or("Conversation"),now()])?;
                let mut rows:Vec<_> = messages.iter().filter(|m|m["conversationId"] == c["_id"]).collect();
                rows.sort_by_key(|m|m["seq"].as_i64().unwrap_or(0));
                let mut previous = 0;
                for m in rows {
                    let seq = m["seq"].as_i64().context("PoC message sequence missing")?;
                    ensure!(seq>previous,"PoC transcript has duplicate or invalid sequences"); previous=seq;
                    ensure!(matches!(text(m,"role")?,"user"|"assistant"),"Unsupported PoC message role");
                    // Preserve sparse PoC sequence anchors, including gaps left
                    // by its non-transactional counter/message writes.
                    tx.execute("UPDATE conversations SET cursor=?2 WHERE id=?1",params![text(c,"_id")?,seq-1])?;
                    append_message(tx,text(c,"_id")?,"legacy",text(m,"role")?,m["content"].as_str().context("Missing PoC message content")?)?;
                }
                let summary = summaries.iter().filter(|s|s["conversationId"] == c["_id"]).max_by_key(|s|s["throughSeq"].as_i64().unwrap_or(0));
                if let Some(summary) = summary {
                    let through = summary["throughSeq"].as_i64().context("Missing summary watermark")?;
                    ensure!(through<=previous,"PoC summary watermark exceeds transcript");
                    tx.execute("INSERT INTO summaries VALUES(?1,?2,?3)",params![text(c,"_id")?,through,text(summary,"content")?])?;
                }
                append_event(tx,text(c,"_id")?,"conversation.imported",json!({"source":source}))?;
            }
            // Every message must have been imported; silently ignoring orphans
            // would violate the durable transcript contract.
            for m in messages {
                let exists:Option<i64> = tx.query_row("SELECT seq FROM messages WHERE conversation_id=?1 AND seq=?2",params![text(m,"conversationId")?,m["seq"].as_i64()],|r|r.get(0)).optional()?;
                ensure!(exists.is_some(),"PoC transcript contains an orphan message");
            }
            for m in memories {
                tx.execute("INSERT INTO memories(id,agent_id,content) VALUES(?1,?2,?3)",params![text(m,"_id")?,text(m,"agentId")?,text(m,"content")?])?;
            }
            tx.execute("INSERT INTO imports VALUES(?1)",[source])?;
            Ok(json!({"agents":agents.len(),"conversations":conversations.len(),"messages":messages.len(),"memories":memories.len(),"alreadyImported":false}))
        })
    }
}
