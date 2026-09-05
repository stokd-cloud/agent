//! Stokd workload semantics ported from apps/cli/src/{config,llm_routing}.rs.
//! Model IDs are data from config/discovery, never a compiled catalog.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf};

#[derive(Clone, Debug)]
pub struct Route {
    pub selector: String,
    pub provider: String,
    pub model: String,
    pub settings: Value,
    pub unavailable: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub root: PathBuf,
    pub routes: Vec<Route>,
    pub prompt_bytes: usize,
    pub timeout_seconds: u64,
    pub embedding: Value,
}

pub fn stokd_home() -> PathBuf {
    std::env::var_os("STOKD_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".stokd")
        })
}

fn read_yaml(path: &std::path::Path) -> Result<Value> {
    let data = std::fs::read_to_string(path)
        .with_context(|| format!("Cannot read config {}", path.display()))?;
    // Do not include YAML parser excerpts: config may contain credentials.
    serde_yaml::from_str(&data).map_err(|_| anyhow::anyhow!("Invalid YAML in {}", path.display()))
}

fn merge(base: &mut Value, overlay: Value) {
    if let (Some(a), Some(b)) = (base.as_object_mut(), overlay.as_object()) {
        for (key, value) in b {
            merge(a.entry(key).or_insert(Value::Null), value.clone());
        }
    } else {
        *base = overlay;
    }
}

impl Config {
    pub fn load() -> Result<Self> {
        let home = stokd_home();
        let explicit = std::env::var_os("STOKD_AGENT_CONFIG");
        let path = explicit
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("config.yaml"));
        let mut doc = if path.exists() {
            read_yaml(&path)?
        } else if explicit.is_some() {
            bail!("STOKD_AGENT_CONFIG does not exist")
        } else {
            json!({})
        };
        // Stokd environment overlays are config, not donor agent profiles.
        if explicit.is_none() {
            let mode = std::env::var("STOKD_ENV").unwrap_or_else(|_| {
                doc["env"]
                    .as_str()
                    .or_else(|| doc["env"]["mode"].as_str())
                    .unwrap_or("local")
                    .into()
            });
            ensure!(
                mode.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                "Invalid STOKD_ENV"
            );
            let overlay = home.join(format!("config.{mode}.yaml"));
            if overlay.exists() {
                merge(&mut doc, read_yaml(&overlay)?);
            }
        }
        let mut catalog = vec![];
        if let Ok(files) = std::fs::read_dir(home.join("cache/provider-models")) {
            for file in files.flatten() {
                if file.path().extension().is_some_and(|e| e == "json")
                    && let Ok(data) = std::fs::read(file.path())
                    && let Ok(v) = serde_json::from_slice::<Value>(&data)
                    && let Some(models) = v["models"].as_array()
                {
                    catalog.extend(models.iter().cloned());
                }
            }
        }
        let root = std::env::var_os("STOKD_AGENT_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("agents"));
        Self::from_document(&doc, &catalog, root)
    }

    pub fn from_document(doc: &Value, catalog: &[Value], root: PathBuf) -> Result<Self> {
        let defaults = string_chain(&doc["models"]["defaults"])?;
        let mut chat = &doc["models"]["workloads"]["chat"];
        if chat.is_object() {
            chat = &chat["models"];
        }
        let chat = string_chain(chat)?;
        let chain = expand_chain(if chat.is_empty() { &defaults } else { &chat }, &defaults);
        let providers = providers(doc)?;
        let mode = if let Some(modes) = doc["models"]["mode"].as_array() {
            modes
                .iter()
                .map(|v| v.as_str().context("models.mode entries must be strings"))
                .collect::<Result<Vec<_>>>()?
                .join(",")
        } else {
            doc["models"]["mode"].as_str().unwrap_or("all").into()
        };
        ensure!(
            mode.split([',', '+', ' '])
                .filter(|s| !s.is_empty())
                .all(|s| matches!(s, "all" | "frontier" | "free" | "local" | "metered")),
            "Invalid models.mode"
        );
        let mut routes = vec![];
        for selector in chain {
            // Directory/cache order is not routing policy. Shared model IDs
            // resolve in the operator's configured provider order.
            let exact = providers.iter().find_map(|(provider, _)| {
                catalog.iter().find(|m| {
                    m["id"].as_str() == Some(&selector)
                        && m["provider"].as_str() == Some(provider)
                        && mode_allows(&mode, provider)
                })
            });
            let mut found = None;
            // Explicit provider/model also supports IDs containing slashes.
            for (provider, settings) in &providers {
                if let Some(model) = selector.strip_prefix(&format!("{provider}/")) {
                    found = Some((provider.clone(), model.to_string(), settings.clone()));
                    break;
                }
            }
            if found.is_none()
                && let Some(model) = exact
            {
                let provider = model["provider"].as_str().unwrap_or_default();
                found = providers
                    .iter()
                    .find(|(p, _)| p == provider)
                    .map(|(p, s)| (p.clone(), selector.clone(), s.clone()));
            }
            if found.is_none() {
                for (provider, settings) in &providers {
                    if let Some(family) = selector.strip_prefix(&format!("{provider}-"))
                        && let Some(model) = catalog
                            .iter()
                            .filter(|m| {
                                m["provider"].as_str() == Some(provider)
                                    && m["id"].as_str().is_some_and(|id| {
                                        id.split(|c: char| !c.is_ascii_alphanumeric())
                                            .any(|part| part.eq_ignore_ascii_case(family))
                                    })
                            })
                            .max_by_key(|m| version(m["id"].as_str().unwrap_or_default()))
                    {
                        found = Some((
                            provider.clone(),
                            model["id"].as_str().unwrap_or_default().into(),
                            settings.clone(),
                        ));
                        break;
                    }
                    if settings["models"]
                        .as_array()
                        .is_some_and(|models| models.iter().any(|m| m.as_str() == Some(&selector)))
                    {
                        found = Some((provider.clone(), selector.clone(), settings.clone()));
                        break;
                    }
                }
            }
            let (provider, model, settings, mut unavailable) = match found {
                Some((p, m, s)) => (p, m, s, None),
                None => (
                    String::new(),
                    selector.clone(),
                    Value::Null,
                    Some(format!(
                        "Unresolved model '{selector}'; run stokd model list --refresh or use provider/model"
                    )),
                ),
            };
            if !mode_allows(&mode, &provider) {
                unavailable = Some(format!("'{selector}' is excluded by models.mode"));
            }
            routes.push(Route {
                selector,
                provider,
                model,
                settings,
                unavailable,
            });
        }
        let prompt_bytes = doc["agent"]["promptBytes"].as_u64().unwrap_or(24_000) as usize;
        ensure!(
            (4096..=256_000).contains(&prompt_bytes),
            "agent.promptBytes must be 4096–256000"
        );
        let timeout_seconds = doc["agent"]["timeoutSeconds"]
            .as_u64()
            .unwrap_or(180)
            .clamp(1, 600);
        Ok(Self {
            root,
            routes,
            prompt_bytes,
            timeout_seconds,
            embedding: doc["agent"]["embedding"].clone(),
        })
    }

    pub fn public_routes(&self) -> Value {
        json!({"workload":"chat","promptBytes":self.prompt_bytes,"routes":self.routes.iter().map(|r| json!({"selector":r.selector,"provider":r.provider,"model":r.model,"unavailable":r.unavailable})).collect::<Vec<_>>()})
    }
}

pub fn expand_chain(chain: &[String], defaults: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    chain
        .iter()
        .flat_map(|s| {
            if s.trim() == "default" {
                defaults.to_vec()
            } else {
                vec![s.clone()]
            }
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "default" && seen.insert(s.clone()))
        .collect()
}

fn string_chain(v: &Value) -> Result<Vec<String>> {
    if v.is_null() {
        return Ok(vec![]);
    }
    v.as_array()
        .context("Model chains must be arrays of model IDs")?
        .iter()
        .map(|x| {
            x.as_str()
                .map(String::from)
                .context("Chat model IDs must be strings")
        })
        .collect()
}

fn providers(doc: &Value) -> Result<Vec<(String, Value)>> {
    let entries = if doc["providers"].is_object() {
        &doc["providers"]["entries"]
    } else {
        &doc["providers"]
    };
    if entries.is_null() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in entries.as_array().context("providers must be a list")? {
        let (name, settings) = if let Some(name) = entry.as_str() {
            (name, json!({}))
        } else if let Some(name) = entry["name"].as_str() {
            (name, entry.clone())
        } else if let Some(map) = entry.as_object().filter(|m| m.len() == 1) {
            let (name, settings) = map.iter().next().unwrap();
            (name.as_str(), settings.clone())
        } else {
            bail!("Invalid provider entry");
        };
        let name = match name {
            "claudeCode" => "claude",
            "openaiCodex" => "codex",
            "lmStudio" | "lm-studio" => "lmstudio",
            other => other,
        };
        out.push((name.to_string(), settings));
    }
    Ok(out)
}

fn version(id: &str) -> Vec<u64> {
    id.split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse().ok())
        .collect()
}

fn pool(provider: &str) -> &str {
    match provider {
        "lmstudio" | "ollama" | "local" => "local",
        "nvidia-nim" | "groq" | "cerebras" | "gemini-free" => "free",
        "claude" | "codex" | "deepseek" | "grok" | "gemini" | "devin" | "droid" | "amp" => {
            "frontier"
        }
        _ => "metered",
    }
}

fn mode_allows(mode: &str, provider: &str) -> bool {
    mode.split([',', '+', ' '])
        .any(|m| m == "all" || pool(provider) == m || (m == "free" && pool(provider) == "local"))
}
