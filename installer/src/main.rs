use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};
use serde::Deserialize;
use std::{
    env, fs,
    io::Cursor,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;
use walkdir::WalkDir;
use zip::ZipArchive;

#[derive(Debug, Parser)]
#[command(name = "key-intercept-installer")]
struct Args {
    #[arg(long)]
    owner_discord_id: String,

    #[arg(long, default_value = "http://82.165.196.147:45491")]
    relay_server_url: Option<String>,

    #[arg(long, default_value = "Key-Intercept")]
    repo_owner: String,

    #[arg(long, default_value = "key-intercept-v2")]
    repo_name: String,

    #[arg(long, default_value = "loopback-server-linux-x86_64")]
    loopback_artifact: String,

    #[arg(long, default_value = "key-intercept-plugin")]
    plugin_artifact: String,

    #[arg(long, default_value = "loopback-server")]
    loopback_binary_name: String,

    #[arg(long, default_value = "keyInterceptSelfHosted.tsx")]
    plugin_file_name: String,
}

#[derive(Debug, Deserialize)]
struct WorkflowRunsResponse {
    workflow_runs: Vec<WorkflowRun>,
}

#[derive(Debug, Deserialize)]
struct WorkflowRun {
    id: u64,
}

#[derive(Debug, Deserialize)]
struct ArtifactsResponse {
    artifacts: Vec<Artifact>,
}

#[derive(Debug, Deserialize)]
struct Artifact {
    id: u64,
    name: String,
    expired: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let client = build_client()?;

    let run_id = latest_successful_run(&client, &args.repo_owner, &args.repo_name).await?;
    let artifacts = list_artifacts(&client, &args.repo_owner, &args.repo_name, run_id).await?;

    let loopback_artifact = find_artifact(&artifacts, &args.loopback_artifact)?;
    let plugin_artifact = find_artifact(&artifacts, &args.plugin_artifact)?;

    let loopback_dir = download_artifact(
        &client,
        &args.repo_owner,
        &args.repo_name,
        loopback_artifact.id,
    )
    .await?;
    let plugin_dir = download_artifact(
        &client,
        &args.repo_owner,
        &args.repo_name,
        plugin_artifact.id,
    )
    .await?;

    install_loopback_binary(&loopback_dir, &args.loopback_binary_name)?;
    install_plugin_file(&plugin_dir, &args.plugin_file_name)?;
    write_systemd_service(&args.owner_discord_id, args.relay_server_url.as_deref())?;
    enable_service()?;

    println!("Installation complete.");
    Ok(())
}

fn build_client() -> Result<reqwest::Client> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("key-intercept-installer"),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );

    if let Ok(token) = env::var("GITHUB_TOKEN") {
        let mut value = String::from("Bearer ");
        value.push_str(&token);
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&value).context("invalid GITHUB_TOKEN")?,
        );
    }

    Ok(reqwest::Client::builder()
        .default_headers(headers)
        .build()?)
}

async fn latest_successful_run(client: &reqwest::Client, owner: &str, repo: &str) -> Result<u64> {
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/actions/runs?status=success&per_page=1"
    );

    let response = client
        .get(url)
        .send()
        .await
        .context("failed to request workflow runs")?
        .error_for_status()
        .context("workflow runs request failed")?;

    let parsed = response
        .json::<WorkflowRunsResponse>()
        .await
        .context("invalid workflow runs response")?;

    parsed
        .workflow_runs
        .first()
        .map(|run| run.id)
        .ok_or_else(|| anyhow!("no successful workflow runs found"))
}

async fn list_artifacts(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    run_id: u64,
) -> Result<Vec<Artifact>> {
    let url =
        format!("https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts");

    let response = client
        .get(url)
        .send()
        .await
        .context("failed to request workflow artifacts")?
        .error_for_status()
        .context("workflow artifacts request failed")?;

    let parsed = response
        .json::<ArtifactsResponse>()
        .await
        .context("invalid workflow artifacts response")?;

    Ok(parsed.artifacts)
}

fn find_artifact<'a>(artifacts: &'a [Artifact], name: &str) -> Result<&'a Artifact> {
    artifacts
        .iter()
        .find(|artifact| artifact.name == name && !artifact.expired)
        .ok_or_else(|| anyhow!("artifact '{name}' not found or expired"))
}

async fn download_artifact(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    artifact_id: u64,
) -> Result<TempDir> {
    let url =
        format!("https://api.github.com/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip");

    let bytes = client
        .get(url)
        .send()
        .await
        .context("failed to download artifact")?
        .error_for_status()
        .context("artifact download failed")?
        .bytes()
        .await
        .context("failed to read artifact body")?;

    let dir = TempDir::new().context("failed to create temporary extraction dir")?;
    unzip_to_dir(&bytes, dir.path())?;
    Ok(dir)
}

fn unzip_to_dir(bytes: &[u8], out_dir: &Path) -> Result<()> {
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader).context("failed to open artifact zip")?;

    for idx in 0..archive.len() {
        let mut entry = archive.by_index(idx).context("failed to read zip entry")?;
        let Some(path) = entry.enclosed_name().map(|p| out_dir.join(p)) else {
            continue;
        };

        if entry.is_dir() {
            fs::create_dir_all(&path)
                .with_context(|| format!("failed to create directory {}", path.display()))?;
            continue;
        }

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory {}", parent.display()))?;
        }

        let mut out = fs::File::create(&path)
            .with_context(|| format!("failed to create {}", path.display()))?;
        std::io::copy(&mut entry, &mut out)
            .with_context(|| format!("failed to write {}", path.display()))?;
    }

    Ok(())
}

fn install_loopback_binary(extracted: &TempDir, binary_name: &str) -> Result<()> {
    let source = find_file_recursive(extracted.path(), binary_name)?;
    let target_dir = home_dir()?.join(".local/bin");
    fs::create_dir_all(&target_dir)
        .with_context(|| format!("failed to create {}", target_dir.display()))?;

    let target = target_dir.join("key-intercept-loopback");
    fs::copy(&source, &target).with_context(|| {
        format!(
            "failed to copy loopback binary from {} to {}",
            source.display(),
            target.display()
        )
    })?;

    let mut perms = fs::metadata(&target)
        .with_context(|| format!("failed to read {} metadata", target.display()))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&target, perms)
        .with_context(|| format!("failed to mark {} executable", target.display()))?;

    Ok(())
}

fn install_plugin_file(extracted: &TempDir, plugin_file_name: &str) -> Result<()> {
    let source = find_file_recursive(extracted.path(), plugin_file_name)?;
    let target_dir = vencord_plugin_dir();
    fs::create_dir_all(&target_dir)
        .with_context(|| format!("failed to create {}", target_dir.display()))?;

    let target = target_dir.join("keyInterceptSelfHosted.tsx");
    fs::copy(&source, &target).with_context(|| {
        format!(
            "failed to copy plugin file from {} to {}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow!("could not determine home directory"))
}

fn vencord_plugin_dir() -> PathBuf {
    if let Ok(path) = env::var("VENCORD_PLUGIN_DIR") {
        return PathBuf::from(path);
    }

    home_dir()
        .map(|home| home.join(".config/Vencord/plugins"))
        .unwrap_or_else(|_| PathBuf::from(".config/Vencord/plugins"))
}

fn find_file_recursive(root: &Path, name: &str) -> Result<PathBuf> {
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() && entry.file_name().to_string_lossy() == name {
            return Ok(entry.path().to_path_buf());
        }
    }

    bail!("file '{name}' not found in artifact")
}

fn write_systemd_service(owner_discord_id: &str, relay_server_url: Option<&str>) -> Result<()> {
    let systemd_user = home_dir()?.join(".config/systemd/user");
    fs::create_dir_all(&systemd_user)
        .with_context(|| format!("failed to create {}", systemd_user.display()))?;

    let service_file = systemd_user.join("key-intercept-loopback.service");
    let mut unit = format!(
        "[Unit]\nDescription=Key Intercept Loopback Server\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={home}/.local/bin/key-intercept-loopback\nEnvironment=OWNER_DISCORD_ID={owner_discord_id}\nEnvironment=LOOPBACK_PORT=35491\nEnvironment=KEY_INTERCEPT_CONFIG_PATH={home}/.config/key-intercept/config.json\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n",
        home = home_dir()?.display(),
    );

    if let Some(relay) = relay_server_url {
        unit = unit.replace(
            "Restart=always",
            &format!("Environment=RELAY_SERVER_URL={relay}\nRestart=always"),
        );
    }

    fs::write(&service_file, unit)
        .with_context(|| format!("failed to write {}", service_file.display()))?;
    Ok(())
}

fn enable_service() -> Result<()> {
    run_systemctl(["--user", "daemon-reload"])?;
    run_systemctl([
        "--user",
        "enable",
        "--now",
        "key-intercept-loopback.service",
    ])?;
    Ok(())
}

fn run_systemctl<const N: usize>(args: [&str; N]) -> Result<()> {
    let status = Command::new("systemctl")
        .args(args)
        .status()
        .context("failed to execute systemctl")?;

    if !status.success() {
        bail!("systemctl command failed with status {status}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use zip::{ZipWriter, write::FileOptions};

    #[test]
    fn find_artifact_skips_expired_entries() {
        let artifacts = vec![
            Artifact {
                id: 1,
                name: "key-intercept-plugin".to_string(),
                expired: true,
            },
            Artifact {
                id: 2,
                name: "key-intercept-plugin".to_string(),
                expired: false,
            },
        ];

        let found = find_artifact(&artifacts, "key-intercept-plugin").unwrap();
        assert_eq!(found.id, 2);
    }

    #[test]
    fn find_artifact_returns_error_when_missing() {
        let artifacts = vec![Artifact {
            id: 1,
            name: "loopback-server-linux-x86_64".to_string(),
            expired: true,
        }];

        let err = find_artifact(&artifacts, "loopback-server-linux-x86_64").unwrap_err();
        assert!(err.to_string().contains("not found or expired"));
    }

    #[test]
    fn unzip_to_dir_extracts_files() {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut bytes);
            zip.start_file::<_, ()>("nested/sample.txt", FileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut zip, b"hello").unwrap();
            zip.finish().unwrap();
        }

        let dir = tempdir().unwrap();
        unzip_to_dir(bytes.get_ref(), dir.path()).unwrap();

        let extracted = dir.path().join("nested/sample.txt");
        let content = std::fs::read_to_string(extracted).unwrap();
        assert_eq!(content, "hello");
    }
}
