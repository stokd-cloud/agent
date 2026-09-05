use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use stokd_agent::{Engine, config::Config, routing, types::Request};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn dispatch(engine: &std::sync::Arc<Engine>, request: Request) -> Value {
    let result: Result<Value> = async {
        let mut method = request.method;
        let mut p = request.params;
        if method == "route.cli" {
            let args: Vec<String> = serde_json::from_value(p["args"].clone())?;
            (method, p) = routing::cli(&args)?;
        }
        if method == "route.slash" {
            let agent = stokd_agent::types::text(&p, "agent")?.to_string();
            let conversation = if let Some(id) = p["conversationId"].as_str() {
                id.to_string()
            } else {
                engine
                    .execute("conversation.open", &json!({"agent":agent}))
                    .await?["conversation"]["id"]
                    .as_str()
                    .context("Conversation missing")?
                    .to_string()
            };
            (method, p) =
                routing::slash(&agent, &conversation, stokd_agent::types::text(&p, "line")?)?;
        }
        if method.starts_with("view.") || method == "legacy.export" {
            return Ok(json!({"view":method,"params":p}));
        }
        let result = engine.execute(&method, &p).await?;
        Ok(json!({"method":method,"value":result}))
    }
    .await;
    match result {
        Ok(result) => json!({"id":request.id,"ok":true,"result":result}),
        Err(error) => {
            json!({"id":request.id,"ok":false,"error":{"code":if error.to_string().starts_with("Unsupported") {"UNSUPPORTED"} else {"DOMAIN_ERROR"},"message":error.to_string()}})
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("serve"),
        "Use the stokd-agent launcher; engine transport: stokd-agent-engine serve"
    );
    let engine = Engine::open(Config::load()?)?;
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let stopping = async {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            tokio::select! { result = tokio::signal::ctrl_c() => result?, _ = term.recv() => {} }
        }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c().await?;
        Ok::<(), std::io::Error>(())
    };
    tokio::pin!(stopping);
    let result:Result<()> = async {
        loop {
            let mut line = Vec::new();
            // fill_buf prevents a malformed client from allocating an unbounded line.
            loop {
                let buf = tokio::select! { result = &mut stopping => { result?; return Ok(()) }, buf=input.fill_buf() => buf? };
                if buf.is_empty() {break;}
                let take = buf.iter().position(|b|*b==b'\n').map(|i|i+1).unwrap_or(buf.len());
                ensure!(line.len()+take<=64*1024*1024,"Protocol request too large");
                line.extend_from_slice(&buf[..take]); input.consume(take);
                if line.last() == Some(&b'\n') {break;}
            }
            if line.is_empty() {break;}
            let response = match serde_json::from_slice::<Request>(&line) {
                Ok(request) => dispatch(&engine,request).await,
                Err(_) => json!({"id":null,"ok":false,"error":{"code":"INVALID_REQUEST","message":"Expected a JSON request with id, method and params"}}),
            };
            output.write_all(serde_json::to_string(&response)?.as_bytes()).await?;
            output.write_all(b"\n").await?;output.flush().await?;
        }
        Ok(())
    }.await;
    engine.shutdown().await;
    result
}
