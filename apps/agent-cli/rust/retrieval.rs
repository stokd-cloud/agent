//! Hybrid retrieval adapted from Stokd rag.rs: normalized vectors, lexical
//! relevance and maximal marginal relevance. Real embeddings are optional;
//! a deterministic hash vector keeps offline recall available.
use crate::{
    context::clip,
    model::{credential, endpoint, limited_response},
    types::Memory,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};

pub struct Retrieval {
    settings: Value,
    // Content is part of the key: corrections can never reuse stale vectors.
    cache: Mutex<HashMap<String, Vec<f32>>>,
}

impl Retrieval {
    pub fn new(settings: Value) -> Self {
        Self {
            settings,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn recall(&self, memories: &[Memory], query: &str) -> (Vec<Memory>, Option<String>) {
        if memories.is_empty() {
            return (vec![], None);
        }
        if self.settings["endpoint"].is_string() {
            match self.semantic(memories, query).await {
                Ok((q, vectors)) => return (rank(memories, query, &q, &vectors, true), None),
                Err(_) => {
                    return (
                        rank_hash(memories, query),
                        Some("Semantic retrieval unavailable; using lexical/hash retrieval".into()),
                    );
                }
            }
        }
        (rank_hash(memories, query), None)
    }

    async fn semantic(
        &self,
        memories: &[Memory],
        query: &str,
    ) -> Result<(Vec<f32>, Vec<Vec<f32>>)> {
        let model = self.settings["model"]
            .as_str()
            .context("agent.embedding.model is required")?;
        let endpoint = endpoint(&self.settings, "", "embeddings")?;
        let mut missing = vec![clip(query, 8000).to_string()];
        {
            let cache = self
                .cache
                .lock()
                .map_err(|_| anyhow::anyhow!("Embedding cache poisoned"))?;
            for memory in memories {
                if !cache.contains_key(&memory.content) {
                    missing.push(memory.content.clone());
                }
            }
        }
        // Batch to keep requests bounded when a large memory corpus is imported.
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let mut query_vector = None;
        for (page, inputs) in missing.chunks(32).enumerate() {
            let mut request = client
                .post(&endpoint)
                .json(&json!({"model":model,"input":inputs}));
            if let Some(key) = credential(&self.settings, "")? {
                request = request.bearer_auth(key);
            }
            let response = request.send().await?;
            ensure!(response.status().is_success(), "Embedding request failed");
            let data: Value =
                serde_json::from_slice(&limited_response(response, 2_000_000).await?)?;
            let rows = data["data"]
                .as_array()
                .context("Invalid embedding response")?;
            ensure!(
                rows.len() == inputs.len(),
                "Embedding result count mismatch"
            );
            let mut ordered = vec![None; inputs.len()];
            for row in rows {
                let index = row["index"].as_u64().context("Missing embedding index")? as usize;
                ensure!(
                    index < ordered.len() && ordered[index].is_none(),
                    "Invalid embedding index"
                );
                let mut vector = row["embedding"]
                    .as_array()
                    .context("Missing embedding vector")?
                    .iter()
                    .map(|v| {
                        v.as_f64()
                            .map(|v| v as f32)
                            .context("Invalid embedding value")
                    })
                    .collect::<Result<Vec<_>>>()?;
                ensure!(
                    !vector.is_empty()
                        && vector.len() <= 8192
                        && vector.iter().all(|x| x.is_finite()),
                    "Invalid embedding dimensions"
                );
                normalize(&mut vector);
                ordered[index] = Some(vector);
            }
            let mut cache = self
                .cache
                .lock()
                .map_err(|_| anyhow::anyhow!("Embedding cache poisoned"))?;
            for (i, (text, vector)) in inputs.iter().zip(ordered).enumerate() {
                let vector = vector.context("Missing embedding")?;
                if page == 0 && i == 0 {
                    query_vector = Some(vector);
                } else {
                    cache.insert(text.clone(), vector);
                }
            }
        }
        let q = query_vector.context("Missing query vector")?;
        let cache = self
            .cache
            .lock()
            .map_err(|_| anyhow::anyhow!("Embedding cache poisoned"))?;
        let vectors = memories
            .iter()
            .map(|m| {
                cache
                    .get(&m.content)
                    .cloned()
                    .context("Missing cached embedding")
            })
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            vectors.iter().all(|v| v.len() == q.len()),
            "Embedding dimension mismatch"
        );
        Ok((q, vectors))
    }

    pub fn invalidate(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.clear();
        }
    }
}

fn terms(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| {
            s.len() >= 3
                && !matches!(
                    *s,
                    "the"
                        | "and"
                        | "are"
                        | "was"
                        | "you"
                        | "your"
                        | "what"
                        | "that"
                        | "this"
                        | "with"
                        | "have"
                        | "from"
                        | "for"
                )
        })
        .map(String::from)
        .collect()
}
fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v {
            *x /= norm;
        }
    }
}
fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}
pub fn hash_embedding(text: &str) -> Vec<f32> {
    let mut vector = vec![0.0; 256];
    for term in terms(text) {
        let mut hash = 0xcbf29ce484222325u64;
        for byte in term.bytes() {
            hash = (hash ^ byte as u64).wrapping_mul(0x100000001b3);
        }
        vector[hash as usize % 256] += 1.0;
    }
    normalize(&mut vector);
    vector
}
fn rank_hash(memories: &[Memory], query: &str) -> Vec<Memory> {
    rank(
        memories,
        query,
        &hash_embedding(query),
        &memories
            .iter()
            .map(|m| hash_embedding(&m.content))
            .collect::<Vec<_>>(),
        false,
    )
}
fn rank(
    memories: &[Memory],
    query: &str,
    q: &[f32],
    vectors: &[Vec<f32>],
    semantic: bool,
) -> Vec<Memory> {
    let query_terms = terms(query);
    let docs: Vec<_> = memories.iter().map(|m| terms(&m.content)).collect();
    let scores: Vec<_> = docs
        .iter()
        .enumerate()
        .map(|(i, doc)| {
            let lexical: f32 = query_terms
                .intersection(doc)
                .map(|term| {
                    let frequency = docs.iter().filter(|d| d.contains(term)).count() as f32;
                    (1.0 + memories.len() as f32 / (1.0 + frequency)).ln()
                })
                .sum();
            let similarity = dot(q, &vectors[i]);
            if lexical > 0.0 || (semantic && similarity >= 0.25) {
                lexical + similarity.max(0.0)
            } else {
                0.0
            }
        })
        .collect();
    let mut selected: Vec<usize> = vec![];
    while selected.len() < 8 {
        let next = (0..memories.len())
            .filter(|i| !selected.contains(i) && scores[*i] > 0.0)
            .max_by(|a, b| {
                let score = |i: usize| {
                    scores[i] * 0.75
                        - selected
                            .iter()
                            .map(|s| dot(&vectors[i], &vectors[*s]))
                            .fold(0.0, f32::max)
                            * 0.25
                };
                score(*a).total_cmp(&score(*b)).then_with(|| b.cmp(a))
            });
        match next {
            Some(i) => selected.push(i),
            None => break,
        }
    }
    selected.into_iter().map(|i| memories[i].clone()).collect()
}
