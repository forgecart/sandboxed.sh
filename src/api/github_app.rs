//! GitHub App installation client.
//!
//! Mints short-lived installation access tokens by signing an App-level JWT
//! with the App's RSA private key and exchanging it at GitHub's
//! `/app/installations/<id>/access_tokens` endpoint. The resulting installation
//! token is cached in-process and reused until its expiry approaches.
//!
//! Used for:
//!   - Listing the repositories the App's installation has access to (the
//!     "repo picker" in the New Mission dialog).
//!   - Cloning those repositories into a mission's workspace before the agent
//!     CLI starts, so a mission opens with the picked repos already laid out
//!     under `<mission_workspace>/repos/<repo_name>/`.
//!
//! Config: `AuthConfig::github_app_{id, installation_id, private_key}` —
//! all three must be present for the client to be usable. When any is missing
//! the routes that depend on this client return 404 and the workspace
//! bootstrap skips the clone step (graceful degradation).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{info, warn};

use super::routes::AppState;

const GITHUB_API: &str = "https://api.github.com";
const USER_AGENT: &str = "sandboxed-sh";
/// Refresh threshold: mint a fresh installation token when the cached one is
/// within this many seconds of expiry. GitHub-issued tokens last 60 minutes,
/// so 300s leaves a comfortable cushion for in-flight requests.
const REFRESH_THRESHOLD_SECONDS: i64 = 300;

#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    expires_at: DateTime<Utc>,
}

/// A repository the user picked when creating a mission. Persisted on the
/// mission record so subsequent restarts / resumes can re-clone if needed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoSelection {
    /// `owner/repo`, e.g. `forgecart/shop-beta`.
    pub full_name: String,
    /// Branch to check out. `None` = the repo's default branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// A repository the App's installation can see. Returned by
/// `GET /api/github/repositories` for the dashboard's picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRepo {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub default_branch: String,
    pub clone_url: String,
    #[serde(default)]
    pub private: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Subset of `GET /app/installations/<id>` we surface on the Settings page.
/// We use `serde_json::Value` for the permissions map so additions on
/// GitHub's side don't require Rust changes.
#[derive(Debug, Clone, Deserialize)]
pub struct InstallationDetails {
    #[serde(default)]
    pub permissions: serde_json::Value,
    #[serde(default)]
    pub repository_selection: String,
    #[serde(default)]
    pub account: Option<InstallationAccount>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InstallationAccount {
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub html_url: Option<String>,
}

/// Per-repo clone outcome surfaced to the agent + dashboard via
/// `<mission_workspace>/repos.json`.
#[derive(Debug, Clone, Serialize)]
pub struct RepoCloneResult {
    pub full_name: String,
    pub branch: Option<String>,
    pub path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Active GitHub App client. All three fields must be set.
pub struct GithubAppClient {
    app_id: String,
    installation_id: String,
    private_key_pem: String,
    http: reqwest::Client,
    cached_token: RwLock<Option<CachedToken>>,
}

impl GithubAppClient {
    pub fn new(
        app_id: String,
        installation_id: String,
        private_key_pem: String,
        http: reqwest::Client,
    ) -> Self {
        Self {
            app_id,
            installation_id,
            private_key_pem,
            http,
            cached_token: RwLock::new(None),
        }
    }

    /// Build the client if all three env vars are present, else `None`.
    pub fn maybe_from_config(
        config: &crate::config::AuthConfig,
        http: reqwest::Client,
    ) -> Option<Arc<Self>> {
        let app_id = config.github_app_id.as_deref()?.trim().to_string();
        let installation_id = config
            .github_app_installation_id
            .as_deref()?
            .trim()
            .to_string();
        let private_key_pem = config.github_app_private_key.as_deref()?.to_string();
        if app_id.is_empty() || installation_id.is_empty() || private_key_pem.trim().is_empty() {
            return None;
        }
        Some(Arc::new(Self::new(
            app_id,
            installation_id,
            private_key_pem,
            http,
        )))
    }

    /// Sign an App-level JWT (RS256). Valid for 9 minutes; the App-JWT only
    /// gets exchanged once per refresh so a short TTL is safe.
    fn build_app_jwt(&self) -> Result<String, String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("clock error: {e}"))?
            .as_secs() as i64;
        #[derive(Serialize)]
        struct Claims {
            iat: i64,
            exp: i64,
            iss: String,
        }
        // iat clock-skew tolerance: backdating by 60s is the GitHub guidance.
        let claims = Claims {
            iat: now - 60,
            exp: now + 9 * 60,
            iss: self.app_id.clone(),
        };
        let key = EncodingKey::from_rsa_pem(self.private_key_pem.as_bytes())
            .map_err(|e| format!("invalid GITHUB_APP_PRIVATE_KEY PEM: {e}"))?;
        jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
            .map_err(|e| format!("JWT sign failed: {e}"))
    }

    /// Return a fresh installation token, minting a new one if the cached
    /// one is missing or within the refresh threshold of expiry.
    pub async fn installation_token(&self) -> Result<String, String> {
        // Fast path: cached + still fresh.
        if let Some(cached) = self.cached_token.read().await.as_ref() {
            let remaining = cached.expires_at.signed_duration_since(Utc::now());
            if remaining.num_seconds() > REFRESH_THRESHOLD_SECONDS {
                return Ok(cached.token.clone());
            }
        }

        let app_jwt = self.build_app_jwt()?;
        let url = format!(
            "{GITHUB_API}/app/installations/{}/access_tokens",
            self.installation_id
        );
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&app_jwt)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("installation token request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("installation token HTTP {status}: {body}"));
        }
        #[derive(Deserialize)]
        struct TokenResp {
            token: String,
            expires_at: DateTime<Utc>,
        }
        let parsed: TokenResp = resp
            .json()
            .await
            .map_err(|e| format!("decode installation token response: {e}"))?;
        let cached = CachedToken {
            token: parsed.token.clone(),
            expires_at: parsed.expires_at,
        };
        *self.cached_token.write().await = Some(cached);
        info!(
            installation_id = %self.installation_id,
            expires_at = %parsed.expires_at,
            "minted fresh GitHub App installation token"
        );
        Ok(parsed.token)
    }

    /// Fetch the installation's metadata (permissions, repo-selection scope,
    /// installed-on account). Requires the App JWT, NOT the installation
    /// token, because we're asking *about* the installation. Used by the
    /// Settings → GitHub page to show "which permissions does the App have?".
    pub async fn installation_details(&self) -> Result<InstallationDetails, String> {
        let app_jwt = self.build_app_jwt()?;
        let url = format!("{GITHUB_API}/app/installations/{}", self.installation_id);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&app_jwt)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("installation details request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("installation details HTTP {status}: {body}"));
        }
        resp.json()
            .await
            .map_err(|e| format!("decode installation details: {e}"))
    }

    /// List repositories the installation can see, following pagination.
    pub async fn list_repositories(&self) -> Result<Vec<GithubRepo>, String> {
        let token = self.installation_token().await?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let url = format!("{GITHUB_API}/installation/repositories?per_page=100&page={page}");
            let resp = self
                .http
                .get(&url)
                .bearer_auth(&token)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("User-Agent", USER_AGENT)
                .send()
                .await
                .map_err(|e| format!("list repos request failed: {e}"))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("list repos HTTP {status}: {body}"));
            }
            #[derive(Deserialize)]
            struct Page {
                repositories: Vec<GithubRepo>,
                #[serde(default)]
                total_count: u32,
            }
            let parsed: Page = resp
                .json()
                .await
                .map_err(|e| format!("decode list repos response: {e}"))?;
            let returned = parsed.repositories.len();
            out.extend(parsed.repositories);
            // Stop when this page is short OR we've fetched everything.
            if returned < 100 || out.len() as u32 >= parsed.total_count {
                break;
            }
            page += 1;
            if page > 50 {
                warn!("list_repositories pagination exceeded 50 pages — truncating");
                break;
            }
        }
        Ok(out)
    }

    /// Clone each picked repo into `<dest_root>/repos/<name>/`. Fails soft per
    /// repo: a single failure logs + records `success: false` in the result,
    /// the rest still clone, the mission still spawns.
    pub async fn clone_repos(
        &self,
        selections: &[RepoSelection],
        dest_root: &Path,
    ) -> Vec<RepoCloneResult> {
        let mut results = Vec::with_capacity(selections.len());
        if selections.is_empty() {
            return results;
        }
        let token = match self.installation_token().await {
            Ok(t) => t,
            Err(e) => {
                warn!(error = %e, "could not mint installation token; skipping clone");
                for sel in selections {
                    results.push(RepoCloneResult {
                        full_name: sel.full_name.clone(),
                        branch: sel.branch.clone(),
                        path: String::new(),
                        success: false,
                        error: Some(format!("installation token: {e}")),
                    });
                }
                return results;
            }
        };
        let repos_root = dest_root.join("repos");
        let logs_root = dest_root.join("logs");
        if let Err(e) = tokio::fs::create_dir_all(&repos_root).await {
            warn!(error = %e, "could not create repos/ dir; skipping clone");
        }
        let _ = tokio::fs::create_dir_all(&logs_root).await;

        for sel in selections {
            let repo_name = sel
                .full_name
                .rsplit('/')
                .next()
                .unwrap_or(&sel.full_name)
                .to_string();
            let target = repos_root.join(&repo_name);
            // Refuse to clobber an existing checkout — re-runs/resumes use the
            // pre-existing repo. Marking success: true so the agent doesn't see
            // a fail-state for a healthy checkout.
            if target.exists() {
                results.push(RepoCloneResult {
                    full_name: sel.full_name.clone(),
                    branch: sel.branch.clone(),
                    path: target.to_string_lossy().to_string(),
                    success: true,
                    error: None,
                });
                continue;
            }
            let log_path = logs_root.join(format!("clone-{repo_name}.log"));
            let url = format!(
                "https://x-access-token:{token}@github.com/{}.git",
                sel.full_name
            );
            let mut cmd = tokio::process::Command::new("git");
            cmd.arg("clone").arg("--depth=1");
            if let Some(branch) = sel.branch.as_deref().filter(|b| !b.trim().is_empty()) {
                cmd.arg("--branch").arg(branch);
            }
            cmd.arg(&url).arg(&target);
            // Pipe stderr to the log file but redact the token from any echo.
            let output = cmd.output().await;
            let result = match output {
                Ok(out) if out.status.success() => {
                    let _ = tokio::fs::write(&log_path, &out.stderr).await;
                    RepoCloneResult {
                        full_name: sel.full_name.clone(),
                        branch: sel.branch.clone(),
                        path: target.to_string_lossy().to_string(),
                        success: true,
                        error: None,
                    }
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                    let redacted = stderr.replace(&token, "***");
                    let _ = tokio::fs::write(&log_path, &redacted).await;
                    warn!(
                        repo = %sel.full_name,
                        status = ?out.status,
                        "git clone failed"
                    );
                    RepoCloneResult {
                        full_name: sel.full_name.clone(),
                        branch: sel.branch.clone(),
                        path: target.to_string_lossy().to_string(),
                        success: false,
                        error: Some(format!(
                            "git clone exited {}: {}",
                            out.status,
                            redacted.lines().last().unwrap_or("")
                        )),
                    }
                }
                Err(e) => {
                    warn!(repo = %sel.full_name, error = %e, "git clone spawn failed");
                    RepoCloneResult {
                        full_name: sel.full_name.clone(),
                        branch: sel.branch.clone(),
                        path: target.to_string_lossy().to_string(),
                        success: false,
                        error: Some(format!("git spawn: {e}")),
                    }
                }
            };
            results.push(result);
        }

        // Persist the result manifest so the agent can `cat repos.json` and
        // see exactly what's where.
        let manifest_path = dest_root.join("repos.json");
        if let Ok(json) = serde_json::to_vec_pretty(&results) {
            let _ = tokio::fs::write(&manifest_path, json).await;
        }
        results
    }

    /// Pick the directory the agent should `cd` into:
    /// - 0 successful clones → the mission dir (no override).
    /// - exactly 1 successful clone → that repo's checkout.
    /// - 2+ successful clones → the mission dir (parent of `repos/`).
    pub fn pick_working_directory(mission_dir: &Path, results: &[RepoCloneResult]) -> PathBuf {
        let successful: Vec<&RepoCloneResult> = results.iter().filter(|r| r.success).collect();
        if successful.len() == 1 {
            let path = PathBuf::from(&successful[0].path);
            if path.exists() {
                return path;
            }
        }
        mission_dir.to_path_buf()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handlers
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/github/repositories` — list repos the App installation sees.
/// Returns 404 when the App isn't configured so the dashboard hides the
/// picker without needing to special-case the error.
pub async fn list_repositories_handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<GithubRepo>>, (StatusCode, String)> {
    let Some(client) = state.github_app.as_ref() else {
        return Err((
            StatusCode::NOT_FOUND,
            "GitHub App not configured".to_string(),
        ));
    };
    client
        .list_repositories()
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}

#[derive(Serialize, Default)]
pub struct GithubAppStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
    /// GitHub's permission map for the installation, e.g. `{ "contents": "read",
    /// "metadata": "read" }`. Surfaced so the Settings page can show users
    /// exactly which permissions the App is missing for cloning + pushing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<serde_json::Value>,
    /// Repo selection on the installation: `all` or `selected`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_selection: Option<String>,
    /// Login + html_url of the org/user this App is installed in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_html_url: Option<String>,
    /// Convenience flags so the dashboard doesn't have to know which keys
    /// in `permissions` matter for cloning vs pushing.
    pub can_read_contents: bool,
    pub can_write_contents: bool,
    /// Last fetch error, if any. Surfaced inline on the Settings page so the
    /// user sees "Bad PEM" / "App suspended" without digging through pod
    /// logs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `GET /api/github/status` — health snapshot for the Settings → GitHub page.
/// Safe to call when the App isn't configured (`enabled: false`). When the
/// App is configured this also calls `GET /app/installations/<id>` so the
/// dashboard can display the installation's permissions, repo-selection
/// scope, and target account in one shot.
pub async fn status_handler(State(state): State<Arc<AppState>>) -> Json<GithubAppStatus> {
    let Some(client) = state.github_app.as_ref() else {
        return Json(GithubAppStatus::default());
    };
    let mut status = GithubAppStatus {
        enabled: true,
        app_id: Some(client.app_id.clone()),
        installation_id: Some(client.installation_id.clone()),
        ..Default::default()
    };
    match client.installation_details().await {
        Ok(details) => {
            let perms = &details.permissions;
            status.can_read_contents = perms
                .get("contents")
                .and_then(|v| v.as_str())
                .map(|s| s == "read" || s == "write")
                .unwrap_or(false);
            status.can_write_contents = perms
                .get("contents")
                .and_then(|v| v.as_str())
                .map(|s| s == "write")
                .unwrap_or(false);
            status.permissions = Some(details.permissions);
            status.repository_selection = Some(details.repository_selection);
            status.account_login = details.account.as_ref().and_then(|a| a.login.clone());
            status.account_html_url = details.account.and_then(|a| a.html_url);
        }
        Err(e) => {
            status.error = Some(e);
        }
    }
    Json(status)
}
