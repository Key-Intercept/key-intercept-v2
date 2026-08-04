use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};
use serde::Deserialize;
use std::{
    env,
    env::consts::EXE_SUFFIX,
    fs,
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

    #[arg(long, default_value = "key-intercept")]
    vencord_plugin_folder: String,

    #[arg(long)]
    plugin_install_mode: Option<String>,
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

#[derive(Debug, Clone)]
struct LocalSources {
    repo_root: PathBuf,
    plugin_file: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if let Some(mode) = args.plugin_install_mode.as_deref() {
        if mode != "vencord-custom" {
            bail!("--plugin-install-mode only supports 'vencord-custom'");
        }
    }

    if let Some(local_sources) = find_local_sources() {
        println!(
            "Detected local repository at {}. Building and installing local sources.",
            local_sources.repo_root.display()
        );
        let loopback_binary = build_local_loopback_binary(&local_sources.repo_root)?;
        install_loopback_binary_from_path(&loopback_binary)?;
        install_plugin_into_vencord(
            &local_sources.plugin_file,
            &args.plugin_file_name,
            &args.vencord_plugin_folder,
        )?;
    } else {
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
        let plugin_source = find_file_recursive(plugin_dir.path(), &args.plugin_file_name)?;
        install_plugin_into_vencord(
            &plugin_source,
            &args.plugin_file_name,
            &args.vencord_plugin_folder,
        )?;
    }

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
    install_loopback_binary_from_path(&source)
}

fn install_loopback_binary_from_path(source: &Path) -> Result<()> {
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

fn install_plugin_into_vencord(
    source: &Path,
    plugin_file_name: &str,
    plugin_folder: &str,
) -> Result<()> {
    let vencord_dir = ensure_vencord_checkout()?;
    sync_vencord_checkout(&vencord_dir)?;
    ensure_pnpm_available()?;
    install_vencord_userplugin(source, &vencord_dir, plugin_folder, plugin_file_name)?;
    run_command_in_dir("pnpm", &pnpm_install_args(), &vencord_dir)?;
    run_command_in_dir("pnpm", &["build"], &vencord_dir)?;
    if let Err(err) = run_command_in_dir("pnpm", &["inject"], &vencord_dir) {
        println!("Warning: `pnpm inject` failed: {err}");
        println!("The plugin may still work after running `pnpm inject` manually.");
    }

    Ok(())
}

fn pnpm_install_args() -> [&'static str; 2] {
    ["install", "--prod=false"]
}

fn find_local_sources() -> Option<LocalSources> {
    let cwd = env::current_dir().ok()?;
    for dir in cwd.ancestors() {
        let loopback_manifest = dir.join("loopback-server/Cargo.toml");
        let plugin_file = dir.join("plugin/keyInterceptSelfHosted.tsx");
        if loopback_manifest.is_file() && plugin_file.is_file() {
            return Some(LocalSources {
                repo_root: dir.to_path_buf(),
                plugin_file,
            });
        }
    }
    None
}

fn build_local_loopback_binary(repo_root: &Path) -> Result<PathBuf> {
    let manifest = repo_root.join("Cargo.toml");
    let status = Command::new("cargo")
        .arg("build")
        .arg("--release")
        .arg("-p")
        .arg("loopback-server")
        .arg("--manifest-path")
        .arg(&manifest)
        .status()
        .context("failed to execute cargo build for local loopback-server")?;

    if !status.success() {
        bail!("local loopback build failed with status {status}");
    }

    let binary = repo_root
        .join("target")
        .join("release")
        .join(format!("loopback-server{EXE_SUFFIX}"));

    if !binary.is_file() {
        bail!("local loopback binary not found at {}", binary.display());
    }

    Ok(binary)
}

fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow!("could not determine home directory"))
}

fn vencord_repo_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join("Vencord"))
}

fn ensure_vencord_checkout() -> Result<PathBuf> {
    let repo_dir = vencord_repo_dir()?;
    if repo_dir.exists() {
        println!(
            "Removing existing Vencord checkout at {} before reinstall.",
            repo_dir.display()
        );
        remove_existing_path(&repo_dir)?;
    }

    run_command(
        "git",
        &[
            "clone",
            "https://github.com/Vendicated/Vencord.git",
            repo_dir.to_string_lossy().as_ref(),
        ],
    )
    .context("failed to clone Vencord repository")?;

    Ok(repo_dir)
}

fn remove_existing_path(path: &Path) -> Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
            .with_context(|| format!("failed to remove existing directory {}", path.display()))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("failed to remove existing file {}", path.display()))?;
    }
    Ok(())
}

fn sync_vencord_checkout(vencord_dir: &Path) -> Result<()> {
    if vencord_dir.join("package.json").is_file() {
        run_command_in_dir_warn("git", &["restore", "package.json"], vencord_dir);
    }
    if vencord_dir.join("pnpm-lock.yaml").is_file() {
        run_command_in_dir_warn("git", &["restore", "pnpm-lock.yaml"], vencord_dir);
    }

    match git_working_tree_clean(vencord_dir) {
        Ok(true) => run_command_in_dir_warn("git", &["pull", "--ff-only"], vencord_dir),
        Ok(false) => println!(
            "Warning: Skipping `git pull` in {} because it has local changes.",
            vencord_dir.display()
        ),
        Err(err) => println!(
            "Warning: Could not determine git status in {}: {err}. Skipping `git pull`.",
            vencord_dir.display()
        ),
    }

    Ok(())
}

fn ensure_pnpm_available() -> Result<()> {
    if command_exists("pnpm") {
        return Ok(());
    }

    if !command_exists("npm") {
        bail!("pnpm not found and npm is unavailable; install pnpm manually and rerun installer");
    }

    run_command("npm", &["install", "-g", "pnpm"])
        .context("failed to install pnpm using npm install -g pnpm")
}

fn command_exists(command: &str) -> bool {
    Command::new(command).arg("--version").status().is_ok()
}

fn install_vencord_userplugin(
    source_file: &Path,
    vencord_dir: &Path,
    plugin_folder: &str,
    plugin_file_name: &str,
) -> Result<()> {
    let destination_dir = vencord_dir.join("src").join("userplugins").join(plugin_folder);
    if destination_dir.exists() {
        fs::remove_dir_all(&destination_dir)
            .with_context(|| format!("failed to clear {}", destination_dir.display()))?;
    }
    fs::create_dir_all(&destination_dir)
        .with_context(|| format!("failed to create {}", destination_dir.display()))?;

    let target_file = destination_dir.join(plugin_entry_file_name(plugin_file_name)?);
    fs::copy(source_file, &target_file).with_context(|| {
        format!(
            "failed to copy plugin file from {} to {}",
            source_file.display(),
            target_file.display()
        )
    })?;

    Ok(())
}

fn plugin_entry_file_name(plugin_file_name: &str) -> Result<&'static str> {
    let plugin_path = Path::new(plugin_file_name);
    let _plugin_stem = plugin_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| anyhow!("invalid plugin file name: {plugin_file_name}"))?;
    let plugin_ext = plugin_path.extension().and_then(|ext| ext.to_str());
    let entry_file = match plugin_ext {
        Some("tsx") | Some("jsx") => "index.tsx",
        _ => "index.ts",
    };
    Ok(entry_file)
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

fn run_command(command: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(command)
        .args(args)
        .status()
        .with_context(|| format!("failed to execute command `{command}`"))?;

    if !status.success() {
        bail!("command `{command}` failed with status {status}");
    }
    Ok(())
}

fn run_command_in_dir(command: &str, args: &[&str], dir: &Path) -> Result<()> {
    let status = Command::new(command)
        .current_dir(dir)
        .args(args)
        .status()
        .with_context(|| format!("failed to execute command `{command}` in {}", dir.display()))?;

    if !status.success() {
        bail!(
            "command `{command}` in {} failed with status {status}",
            dir.display()
        );
    }
    Ok(())
}

fn run_command_in_dir_warn(command: &str, args: &[&str], dir: &Path) {
    if let Err(err) = run_command_in_dir(command, args, dir) {
        println!("Warning: {err}");
    }
}

fn git_working_tree_clean(dir: &Path) -> Result<bool> {
    let output = Command::new("git")
        .current_dir(dir)
        .args(git_status_clean_args())
        .output()
        .with_context(|| format!("failed to execute git status in {}", dir.display()))?;

    if !output.status.success() {
        bail!("git status failed with status {}", output.status);
    }

    Ok(output.stdout.is_empty())
}

fn git_status_clean_args() -> [&'static str; 3] {
    ["status", "--porcelain", "--untracked-files=no"]
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{NamedTempFile, tempdir};
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

    #[test]
    fn install_vencord_userplugin_copies_source_to_index_entrypoint() {
        let vencord_dir = tempdir().unwrap();
        std::fs::create_dir_all(vencord_dir.path().join("src").join("userplugins")).unwrap();
        let source = NamedTempFile::new().unwrap();
        std::fs::write(source.path(), "export default definePlugin({ name: \"x\" });").unwrap();

        install_vencord_userplugin(
            source.path(),
            vencord_dir.path(),
            "key-intercept",
            "keyInterceptSelfHosted.tsx",
        )
        .unwrap();

        let plugin_dir = vencord_dir
            .path()
            .join("src")
            .join("userplugins")
            .join("key-intercept");
        let entry = std::fs::read_to_string(plugin_dir.join("index.tsx")).unwrap();
        assert!(entry.contains("definePlugin"));
        assert!(!plugin_dir.join("keyInterceptSelfHosted.tsx").exists());
    }

    #[test]
    fn plugin_entry_file_name_prefers_tsx_for_jsx_or_tsx_plugins() {
        assert_eq!(plugin_entry_file_name("plugin.tsx").unwrap(), "index.tsx");
        assert_eq!(plugin_entry_file_name("plugin.jsx").unwrap(), "index.tsx");
    }

    #[test]
    fn plugin_entry_file_name_defaults_to_ts_for_other_extensions() {
        assert_eq!(plugin_entry_file_name("plugin.ts").unwrap(), "index.ts");
        assert_eq!(plugin_entry_file_name("plugin.js").unwrap(), "index.ts");
        assert_eq!(plugin_entry_file_name("index.ts").unwrap(), "index.ts");
    }

    #[test]
    fn pnpm_install_includes_dev_dependencies() {
        assert_eq!(pnpm_install_args(), ["install", "--prod=false"]);
    }

    #[test]
    fn git_status_clean_ignores_untracked_files() {
        assert_eq!(
            git_status_clean_args(),
            ["status", "--porcelain", "--untracked-files=no"]
        );
    }

    #[test]
    fn remove_existing_path_deletes_directory_tree() {
        let root = tempdir().unwrap();
        let nested = root.path().join("nested");
        std::fs::create_dir_all(nested.join("child")).unwrap();
        std::fs::write(nested.join("child").join("sample.txt"), "data").unwrap();

        remove_existing_path(&nested).unwrap();
        assert!(!nested.exists());
    }

}
