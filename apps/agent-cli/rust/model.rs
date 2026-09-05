use crate::{
    config::{Config, Route},
    context::RESPONSE_BYTES,
};
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub struct Completion {
    pub text: String,
    pub model: String,
    pub failures: Vec<String>,
}

#[async_trait]
pub trait Model: Send + Sync {
    async fn complete(&self, prompt: &str, cancel: &CancellationToken) -> Result<Completion>;
}

pub struct RoutedModel {
    pub config: Arc<Config>,
    client: reqwest::Client,
}

impl RoutedModel {
    pub fn new(config: Arc<Config>) -> Result<Self> {
        Ok(Self {
            config,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }

    async fn invoke(&self, route: &Route, prompt: &str) -> Result<String> {
        if let Some(error) = &route.unavailable {
            bail!("{error}");
        }
        if route.settings["command"].is_string() {
            return command_model(route, prompt).await;
        }
        match route.provider.as_str() {
            "claude" | "codex" => command_model(route, prompt).await,
            "deepseek" | "grok" | "openai" | "openrouter" | "lmstudio" | "ollama" => {
                self.http(route, prompt).await
            }
            _ if route.settings["endpoint"].is_string() => self.http(route, prompt).await,
            _ => bail!("Provider has no isolated text transport; configure endpoint or command"),
        }
    }

    async fn http(&self, route: &Route, prompt: &str) -> Result<String> {
        let (default_endpoint, key_env) = match route.provider.as_str() {
            "deepseek" => ("https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
            "grok" => ("https://api.x.ai/v1", "XAI_API_KEY"),
            "openai" => ("https://api.openai.com/v1", "OPENAI_API_KEY"),
            "openrouter" => ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
            "lmstudio" => ("http://127.0.0.1:1234/v1", ""),
            "ollama" => ("http://127.0.0.1:11434/v1", ""),
            _ => ("", ""),
        };
        let endpoint = endpoint(&route.settings, default_endpoint, "chat/completions")?;
        let mut request = self.client.post(endpoint).json(&json!({"model":route.model,"messages":[{"role":"user","content":prompt}],"stream":false,"max_tokens":4096}));
        if let Some(key) = credential(&route.settings, key_env)? {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Provider connection failed"))?;
        ensure!(
            response.status().is_success(),
            "Provider returned HTTP {}",
            response.status().as_u16()
        );
        let body = limited_response(response, RESPONSE_BYTES * 8).await?;
        let value: Value =
            serde_json::from_slice(&body).context("Provider returned invalid JSON")?;
        value["choices"][0]["message"]["content"]
            .as_str()
            .map(String::from)
            .context("Provider returned no text content")
    }
}

#[async_trait]
impl Model for RoutedModel {
    async fn complete(&self, prompt: &str, cancel: &CancellationToken) -> Result<Completion> {
        ensure!(
            prompt.len() <= self.config.prompt_bytes,
            "Inference exceeds prompt byte budget"
        );
        ensure!(
            !self.config.routes.is_empty(),
            "No agent models configured; set models.workloads.agent or models.defaults in Stokd config"
        );
        let mut failures = vec![];
        for route in &self.config.routes {
            let result = tokio::select! {
                biased;
                _ = cancel.cancelled() => bail!("Cancelled"),
                result = tokio::time::timeout(Duration::from_secs(self.config.timeout_seconds),self.invoke(route,prompt)) => result.unwrap_or_else(|_| Err(anyhow::anyhow!("Provider timed out"))),
            };
            match result {
                Ok(text) if !text.trim().is_empty() && text.len() <= RESPONSE_BYTES => {
                    return Ok(Completion {
                        text: text.trim().into(),
                        model: format!("{}/{}", route.provider, route.model),
                        failures,
                    });
                }
                Ok(_) => failures.push(format!("{}: empty or oversized response", route.selector)),
                Err(error) => failures.push(format!("{}: {error}", route.selector)),
            }
        }
        bail!("All agent models failed: {}", failures.join("; "))
    }
}

/// Read an HTTP body with a hard cap, including unknown/chunked lengths.
pub async fn limited_response(mut response: reqwest::Response, cap: usize) -> Result<Vec<u8>> {
    ensure!(
        response.content_length().is_none_or(|n| n <= cap as u64),
        "Provider response too large"
    );
    let mut bytes = vec![];
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Provider response interrupted"))?
    {
        ensure!(
            bytes.len() + chunk.len() <= cap,
            "Provider response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn credential(settings: &Value, default_env: &str) -> Result<Option<String>> {
    if let Some(env) = settings["apiKeyEnv"].as_str() {
        return Ok(Some(
            std::env::var(env).context("Configured API key environment variable is unset")?,
        ));
    }
    if let Some(key) = settings["apiKey"].as_str() {
        if let Some(env) = key.strip_prefix("${").and_then(|s| s.strip_suffix('}')) {
            return Ok(Some(
                std::env::var(env).context("Configured API key environment variable is unset")?,
            ));
        }
        if !key.is_empty() {
            return Ok(Some(key.into()));
        }
    }
    if default_env.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        std::env::var(default_env).with_context(|| format!("{default_env} is unset"))?,
    ))
}

pub fn endpoint(settings: &Value, default: &str, suffix: &str) -> Result<String> {
    let raw = settings["endpoint"].as_str().unwrap_or(default);
    let mut url =
        reqwest::Url::parse(raw).map_err(|_| anyhow::anyhow!("Invalid provider endpoint"))?;
    ensure!(
        url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))),
        "Provider endpoint must use HTTPS or local HTTP"
    );
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Endpoint must not embed credentials, query or fragment"
    );
    if let Some(port) = settings["port"].as_u64() {
        url.set_port(Some(port.try_into().context("Invalid provider port")?))
            .map_err(|_| anyhow::anyhow!("Invalid endpoint port"))?;
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.is_empty() { "/v1" } else { path };
    if !path.ends_with(suffix) {
        url.set_path(&format!("{path}/{suffix}"));
    }
    Ok(url.into())
}

// Kill the entire isolated process group when a future is dropped (timeout,
// cancellation, EOF). kill_on_drop additionally reaps the direct child.
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

async fn read_limited(reader: impl AsyncRead + Unpin, max: usize) -> Result<Vec<u8>> {
    let mut out = vec![];
    reader.take((max + 1) as u64).read_to_end(&mut out).await?;
    ensure!(out.len() <= max, "Model process output too large");
    Ok(out)
}

async fn command_model(route: &Route, prompt: &str) -> Result<String> {
    let scratch = tempfile::tempdir()?;
    let mut cmd = if let Some(command) = route.settings["command"].as_str() {
        let mut cmd = Command::new(command);
        if let Some(args) = route.settings["args"].as_array() {
            for arg in args {
                cmd.arg(
                    arg.as_str()
                        .context("Provider args must be strings")?
                        .replace("{model}", &route.model),
                );
            }
        }
        cmd
    } else if route.provider == "claude" {
        let mut cmd = Command::new("claude");
        cmd.args(["--bare","-p","--model",&route.model,"--output-format","text","--tools","","--strict-mcp-config","--mcp-config","{\"mcpServers\":{}}","--setting-sources","","--no-session-persistence","--system-prompt","You are a text inference backend. Follow the supplied durable agent identity. No tools are available."]);
        cmd
    } else {
        let mut cmd = Command::new("codex");
        cmd.args([
            "exec",
            "--model",
            &route.model,
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
            "--json",
            "--disable",
            "shell_tool",
            "--disable",
            "apply_patch_freeform",
            "--disable",
            "multi_agent",
            "-c",
            "mcp_servers={}",
            "-c",
            "web_search=\"disabled\"",
            "-c",
            "project_doc_max_bytes=0",
            "-",
        ]);
        cmd
    };
    cmd.current_dir(scratch.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Prevent this harness session's routing/hook/profile injection leaking into inference.
    for (key, _) in std::env::vars().filter(|(k, _)| {
        k.starts_with("STOKD_")
            || k.starts_with("DSH_")
            || k.starts_with("CLAUDE_CODE_")
            || k.starts_with("CODEX_THREAD")
            || k == "CLAUDECODE"
            || k == "NODE_OPTIONS"
    }) {
        cmd.env_remove(key);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().context("Model executable is unavailable")?;
    let _group = ProcessGroup(child.id().context("Model process has no ID")?);
    let mut stdin = child.stdin.take().context("Missing model stdin")?;
    let stdout = child.stdout.take().context("Missing model stdout")?;
    let stderr = child.stderr.take().context("Missing model stderr")?;
    let write = async {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
        drop(stdin);
        Ok::<_, anyhow::Error>(())
    };
    let (_, out, _err, status) = tokio::try_join!(
        write,
        read_limited(stdout, RESPONSE_BYTES * 16),
        read_limited(stderr, 64_000),
        async { Ok::<_, anyhow::Error>(child.wait().await?) }
    )?;
    ensure!(
        status.success(),
        "Model process exited unsuccessfully ({})",
        status
            .code()
            .map(|x| x.to_string())
            .unwrap_or_else(|| "signal".into())
    );
    let output = String::from_utf8(out).context("Model output is not UTF-8")?;
    if route.provider == "codex" && !route.settings["command"].is_string() {
        return output
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|v| v["type"] == "item.completed" && v["item"]["type"] == "agent_message")
            .filter_map(|v| v["item"]["text"].as_str().map(String::from))
            .next_back()
            .context("Codex returned no final message");
    }
    Ok(output)
}
