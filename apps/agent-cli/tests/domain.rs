use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use stokd_agent::{
    Engine,
    config::{Config, expand_chain},
    context::{assemble, compact_prompt},
    model::{Completion, Model},
    retrieval::Retrieval,
    types::{Agent, Memory, Message, Summary},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct FixtureModel {
    prompts: Mutex<Vec<String>>,
}
#[async_trait]
impl Model for FixtureModel {
    async fn complete(&self, prompt: &str, cancel: &CancellationToken) -> Result<Completion> {
        self.prompts.lock().unwrap().push(prompt.to_string());
        if prompt.contains("Current user message:\nBLOCK\n") {
            cancel.cancelled().await;
            anyhow::bail!("cancelled");
        }
        let text = if prompt.starts_with("Extract durable") {
            "[\"The user's favorite compass is named Juniper.\"]"
        } else if prompt.starts_with("Rewrite this rolling") {
            "The user named their compass Juniper and is planning a long journey."
        } else {
            "I remember Juniper."
        };
        Ok(Completion {
            text: text.into(),
            model: "fixture/test".into(),
            failures: vec![],
        })
    }
}
fn fixture() -> (tempfile::TempDir, Arc<Engine>, Arc<FixtureModel>) {
    let dir = tempfile::tempdir().unwrap();
    let config = Config::from_document(&json!({}), &[], dir.path().into()).unwrap();
    let model = Arc::new(FixtureModel::default());
    let engine = Engine::with_model(Arc::new(config), model.clone()).unwrap();
    (dir, engine, model)
}
async fn conversation(engine: &Arc<Engine>, name: &str) -> String {
    engine
        .execute("agent.create", &json!({"name":name,"installShim":false}))
        .await
        .unwrap();
    engine
        .execute("conversation.open", &json!({"agent":name}))
        .await
        .unwrap()["conversation"]["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn wait(engine: &Arc<Engine>, agent: &str, id: &str) -> Value {
    for _ in 0..300 {
        let snapshot = engine
            .execute(
                "conversation.snapshot",
                &json!({"agent":agent,"conversationId":id}),
            )
            .await
            .unwrap();
        if snapshot["turn"]["state"] != "running" {
            return snapshot;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("turn did not finish")
}

#[test]
fn prompt_is_bounded_for_long_unicode_history_and_rejects_mandatory_overflow() {
    let agent = Agent {
        id: "a".into(),
        name: "navigator".into(),
        identity: "Help plan routes".into(),
        remit: "Maps".into(),
    };
    let memories = (0..20)
        .map(|i| Memory {
            id: i.to_string(),
            content: "compass 🧭 ".repeat(200),
            revision: 1,
            source_seq: 1,
        })
        .collect::<Vec<_>>();
    let recent = (0..1000)
        .map(|i| Message {
            seq: i,
            role: "user".into(),
            content: "Ancient history 🧭".repeat(1000),
            turn_id: "t".into(),
        })
        .collect::<Vec<_>>();
    let summary = Summary {
        content: "Very long rolling summary".repeat(9000),
        through_seq: 900,
    };
    for budget in [4096, 6000, 24000] {
        let prompt = assemble(
            &agent,
            &memories,
            &summary,
            &recent,
            "Where is Juniper?",
            budget,
        )
        .unwrap();
        assert!(prompt.len() <= budget);
        assert!(prompt.contains("Where is Juniper?"));
        assert!(!prompt.contains("Ancient history"));
        assert!(
            assemble(
                &agent,
                &memories,
                &summary,
                &recent,
                &"🧭".repeat(budget),
                budget
            )
            .is_err()
        );
        let (prompt, _) = compact_prompt(&summary, &recent, budget);
        assert!(prompt.len() <= budget);
    }
}

#[test]
fn workload_sentinel_aliases_and_strict_local_pool() {
    assert_eq!(
        expand_chain(
            &["one".into(), "default".into(), "one".into(), "three".into()],
            &["two".into(), "default".into()]
        ),
        vec!["one", "two", "three"]
    );
    let doc = json!({"providers":["claude","codex"],"models":{"defaults":["codex-sol"],"workloads":{"chat":{"models":["claude-opus","default"]}}}});
    let catalog = vec![
        json!({"provider":"claude","id":"claude-opus-4-8"}),
        json!({"provider":"claude","id":"claude-opus-5"}),
        json!({"provider":"codex","id":"gpt-5.6-sol"}),
    ];
    let config = Config::from_document(&doc, &catalog, PathBuf::new()).unwrap();
    assert_eq!(
        config
            .routes
            .iter()
            .map(|r| r.model.as_str())
            .collect::<Vec<_>>(),
        vec!["claude-opus-5", "gpt-5.6-sol"]
    );
    let mut local = doc;
    local["models"]["mode"] = json!("local");
    assert!(
        Config::from_document(&local, &catalog, PathBuf::new())
            .unwrap()
            .routes
            .iter()
            .all(|r| r.unavailable.is_some())
    );
    let doc = json!({"providers":["lmStudio","codex"],"models":{"mode":"free","workloads":{"chat":["shared"]}}});
    let catalog = vec![
        json!({"provider":"codex","id":"shared"}),
        json!({"provider":"lmstudio","id":"shared"}),
    ];
    let config = Config::from_document(&doc, &catalog, PathBuf::new()).unwrap();
    assert_eq!(config.routes[0].provider, "lmstudio");
    assert!(config.routes[0].unavailable.is_none());
    let mut doc = doc;
    doc["models"]["mode"] = json!("all");
    assert_eq!(
        Config::from_document(&doc, &catalog, PathBuf::new())
            .unwrap()
            .routes[0]
            .provider,
        "lmstudio"
    );
}
use std::path::PathBuf;

#[tokio::test]
async fn forty_turns_compact_without_deleting_transcript_and_recall_after_restart() {
    let (dir, engine, model) = fixture();
    let c = conversation(&engine, "navigator").await;
    for i in 0..40 {
        engine.execute("turn.submit",&json!({"agent":"navigator","conversationId":c,"text":format!("Juniper journey turn {i}. {}","route detail ".repeat(100))})).await.unwrap();
        assert_eq!(
            wait(&engine, "navigator", &c).await["turn"]["state"],
            "complete"
        );
    }
    let snapshot = engine
        .execute(
            "conversation.snapshot",
            &json!({"agent":"navigator","conversationId":c}),
        )
        .await
        .unwrap();
    assert!(snapshot["summary"]["throughSeq"].as_i64().unwrap() > 0);
    assert_eq!(engine.store.messages(&c, i64::MAX, 120).unwrap().len(), 80);
    {
        let prompts = model.prompts.lock().unwrap();
        assert!(prompts.iter().all(|p| p.len() <= 24000));
        assert!(
            prompts.last().unwrap().contains("summary")
                || prompts.last().unwrap().starts_with("Extract")
        );
    }
    engine.shutdown().await;
    drop(engine);
    let config = Config::from_document(&json!({}), &[], dir.path().into()).unwrap();
    let reopened = Engine::with_model(Arc::new(config), model.clone()).unwrap();
    assert_eq!(
        reopened.store.messages(&c, i64::MAX, 120).unwrap().len(),
        80
    );
    reopened.execute("turn.submit",&json!({"agent":"navigator","conversationId":c,"text":"What is the name of my compass?"})).await.unwrap();
    wait(&reopened, "navigator", &c).await;
    assert!(
        model
            .prompts
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|p| p.starts_with("You are"))
            .unwrap()
            .contains("Retrieved memories:\n- The user's favorite compass is named Juniper.")
    );
    reopened.shutdown().await;
}

#[tokio::test]
async fn failed_size_validation_does_not_append_and_cancel_fences_reply() {
    let (_dir, engine, _) = fixture();
    let c = conversation(&engine, "navigator").await;
    assert!(
        engine
            .execute(
                "turn.submit",
                &json!({"agent":"navigator","conversationId":c,"text":"x".repeat(30000)})
            )
            .await
            .is_err()
    );
    assert!(engine.store.messages(&c, i64::MAX, 120).unwrap().is_empty());
    engine
        .execute(
            "turn.submit",
            &json!({"agent":"navigator","conversationId":c,"text":"BLOCK"}),
        )
        .await
        .unwrap();
    assert!(
        engine
            .execute(
                "turn.submit",
                &json!({"agent":"navigator","conversationId":c,"text":"second"})
            )
            .await
            .is_err()
    );
    engine
        .execute(
            "turn.cancel",
            &json!({"agent":"navigator","conversationId":c}),
        )
        .await
        .unwrap();
    let messages = engine.store.messages(&c, i64::MAX, 120).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "user");
    assert_eq!(
        wait(&engine, "navigator", &c).await["turn"]["state"],
        "cancelled"
    );
    engine
        .execute(
            "turn.steer",
            &json!({"agent":"navigator","conversationId":c,"text":"New direction"}),
        )
        .await
        .unwrap();
    assert_eq!(
        wait(&engine, "navigator", &c).await["turn"]["state"],
        "complete"
    );
    assert_eq!(engine.store.messages(&c, i64::MAX, 120).unwrap().len(), 3);
    engine.shutdown().await;
}

#[tokio::test]
async fn concurrent_engine_cannot_recover_live_turn_but_can_cancel_it() {
    let (dir, engine, model) = fixture();
    let c = conversation(&engine, "navigator").await;
    engine
        .execute(
            "turn.submit",
            &json!({"agent":"navigator","conversationId":c,"text":"BLOCK"}),
        )
        .await
        .unwrap();
    let other = Engine::with_model(
        Arc::new(Config::from_document(&json!({}), &[], dir.path().into()).unwrap()),
        model,
    )
    .unwrap();
    let snapshot = other
        .execute(
            "conversation.snapshot",
            &json!({"agent":"navigator","conversationId":c}),
        )
        .await
        .unwrap();
    assert_eq!(snapshot["turn"]["state"], "running");
    assert!(
        other
            .execute(
                "turn.submit",
                &json!({"agent":"navigator","conversationId":c,"text":"racing"})
            )
            .await
            .is_err()
    );
    other
        .execute(
            "turn.cancel",
            &json!({"agent":"navigator","conversationId":c}),
        )
        .await
        .unwrap();
    assert_eq!(
        wait(&engine, "navigator", &c).await["turn"]["state"],
        "cancelled"
    );
    engine.shutdown().await;
    other.shutdown().await;
}

#[tokio::test]
async fn memory_edits_are_revision_fenced_and_removed_facts_stay_removed() {
    let (_dir, engine, _) = fixture();
    let c = conversation(&engine, "navigator").await;
    let p = json!({"agent":"navigator","conversationId":c,"text":"My compass is Juniper"});
    engine.execute("turn.submit", &p).await.unwrap();
    wait(&engine, "navigator", &c).await;
    let agent = engine.store.agent("navigator").unwrap();
    let memory = engine.store.memories(&agent.id).unwrap().remove(0);
    let edit = json!({"agent":"navigator","id":memory.id,"revision":1,"content":"The compass is named Cedar."});
    engine.execute("memory.correct", &edit).await.unwrap();
    assert!(engine.execute("memory.correct", &edit).await.is_err());
    engine.execute("turn.submit", &p).await.unwrap();
    wait(&engine, "navigator", &c).await;
    let memories = engine.store.memories(&agent.id).unwrap();
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].content, "The compass is named Cedar.");
    engine
        .execute(
            "memory.forget",
            &json!({"agent":"navigator","id":memory.id,"revision":2}),
        )
        .await
        .unwrap();
    engine.execute("turn.submit", &p).await.unwrap();
    wait(&engine, "navigator", &c).await;
    assert!(engine.store.memories(&agent.id).unwrap().is_empty());
    assert_eq!(engine.store.messages(&c, i64::MAX, 120).unwrap().len(), 6);
    engine.shutdown().await;
}

#[tokio::test]
async fn approval_applies_once_and_agent_scope_cannot_be_crossed() {
    let (_dir, engine, _) = fixture();
    let c = conversation(&engine, "navigator").await;
    let other = conversation(&engine, "outsider").await;
    let params = json!({"agent":"navigator","conversationId":c,"action":{"kind":"artifact.create","title":"Map","content":"# Juniper route"}});
    let approval = engine.execute("approval.propose", &params).await.unwrap();
    assert_eq!(
        engine.execute("artifact.list", &params).await.unwrap(),
        json!([])
    );
    let resolve = json!({"agent":"navigator","conversationId":c,"id":approval["id"],"allow":true});
    assert!(
        engine
            .execute(
                "approval.resolve",
                &json!({"agent":"outsider","conversationId":other,"id":approval["id"],"allow":true})
            )
            .await
            .is_err()
    );
    engine.execute("approval.resolve", &resolve).await.unwrap();
    assert!(engine.execute("approval.resolve", &resolve).await.is_err());
    assert_eq!(
        engine
            .execute("artifact.list", &params)
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        engine
            .execute(
                "conversation.replay",
                &json!({"agent":"outsider","conversationId":c})
            )
            .await
            .is_err()
    );
    assert!(engine.execute("approval.propose",&json!({"agent":"navigator","conversationId":c,"action":{"kind":"shell","title":"run a command"}})).await.is_err());
    let work=engine.execute("approval.propose",&json!({"agent":"navigator","conversationId":c,"action":{"kind":"work.create","title":"Plan trip"}})).await.unwrap();
    engine
        .execute(
            "approval.resolve",
            &json!({"agent":"navigator","conversationId":c,"id":work["id"],"allow":false}),
        )
        .await
        .unwrap();
    assert_eq!(
        engine.execute("work.list", &params).await.unwrap(),
        json!([])
    );
}

#[tokio::test]
async fn replay_is_ordered_pageable_and_recovery_preserves_provisional_status() {
    let (_dir, engine, _) = fixture();
    let c = conversation(&engine, "navigator").await;
    engine.store.transaction(|tx| {
        tx.execute("INSERT INTO turns(id,conversation_id,state,stage) VALUES('dead',?1,'running','thinking')",[&c])?;
        stokd_agent::store::append_message(tx,&c,"dead","user","Hello")?;
        stokd_agent::store::append_event(tx,&c,"response.provisional",json!({"turnId":"dead","content":"Not committed"}))?;Ok(())
    }).unwrap();
    let snapshot = engine
        .execute(
            "conversation.open",
            &json!({"agent":"navigator","conversationId":c}),
        )
        .await
        .unwrap();
    assert_eq!(snapshot["turn"]["state"], "interrupted");
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 1);
    let mut cursor = 0;
    let mut kinds = vec![];
    loop {
        let page = engine
            .execute(
                "conversation.replay",
                &json!({"agent":"navigator","conversationId":c,"after":cursor,"limit":1}),
            )
            .await
            .unwrap();
        for event in page["events"].as_array().unwrap() {
            assert_eq!(event["seq"], cursor + 1);
            cursor += 1;
            kinds.push(event["kind"].clone());
        }
        if page["hasMore"] == false {
            break;
        }
    }
    assert_eq!(
        kinds,
        vec![
            json!("message.committed"),
            json!("response.provisional"),
            json!("turn.interrupted")
        ]
    );
}

#[tokio::test]
async fn retrieval_ignores_common_words_and_keeps_rare_fact() {
    let retrieval = Retrieval::new(Value::Null);
    let memories = vec![
        Memory {
            id: "one".into(),
            content: "The compass is named Juniper".into(),
            revision: 1,
            source_seq: 1,
        },
        Memory {
            id: "two".into(),
            content: "The user likes tea".into(),
            revision: 1,
            source_seq: 1,
        },
    ];
    let (result, warning) = retrieval
        .recall(&memories, "What is my compass called?")
        .await;
    assert!(warning.is_none());
    assert_eq!(result[0].id, "one");
    assert!(
        retrieval
            .recall(&memories, "the and was")
            .await
            .0
            .is_empty()
    );
}

#[test]
fn routes_are_explicit_and_do_not_turn_unsupported_actions_into_chat() {
    for line in [
        "!ls",
        "$ls",
        "/reload",
        "/plugins",
        "/model next",
        "/editor",
        "/export",
        "/resume",
        "/preset x",
        "/btw hello",
    ] {
        assert!(
            stokd_agent::routing::slash("a", "c", line).is_err(),
            "{line}"
        );
    }
    assert_eq!(
        stokd_agent::routing::slash("a", "c", "/new Topic")
            .unwrap()
            .0,
        "conversation.new"
    );
    assert_eq!(
        stokd_agent::routing::slash("a", "c", "Hello").unwrap().0,
        "turn.submit"
    );
}

#[tokio::test]
async fn legacy_import_preserves_sequences_watermarks_and_rolls_back_corruption() {
    let (_dir, engine, _) = fixture();
    let data = json!({"source":"fixture","data":{"agents":[{"_id":"a","name":"legacy","identity":"Persistent"}],"conversations":[{"_id":"c","agentId":"a"}],"messages":[{"conversationId":"c","seq":1,"role":"user","content":"Juniper"},{"conversationId":"c","seq":3,"role":"assistant","content":"Hello"}],"summaries":[{"conversationId":"c","throughSeq":1,"content":"Compass Juniper"}],"memories":[{"_id":"m","agentId":"a","content":"Compass Juniper"}]}});
    let mut bad = data.clone();
    bad["data"]["summaries"][0]["throughSeq"] = json!(100);
    assert!(engine.execute("legacy.import", &bad).await.is_err());
    assert!(engine.store.agent("legacy").is_err());
    engine.execute("legacy.import", &data).await.unwrap();
    assert_eq!(
        engine
            .store
            .messages("c", i64::MAX, 120)
            .unwrap()
            .iter()
            .map(|m| m.seq)
            .collect::<Vec<_>>(),
        vec![1, 3]
    );
    assert_eq!(engine.store.summary("c").unwrap().through_seq, 1);
    assert_eq!(
        engine.execute("legacy.import", &data).await.unwrap()["alreadyImported"],
        true
    );
}
