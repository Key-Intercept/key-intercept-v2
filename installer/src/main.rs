use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};
use serde::Deserialize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    env,
    env::consts::EXE_SUFFIX,
    fs,
    io::Cursor,
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
    owner_discord_id: Option<String>,

    #[arg(long)]
    relay_server_url: Option<String>,

    #[arg(long, default_value = "Key-Intercept")]
    repo_owner: String,

    #[arg(long, default_value = "key-intercept-v2")]
    repo_name: String,

    #[arg(long)]
    loopback_artifact: Option<String>,

    #[arg(long, default_value = "key-intercept-plugin")]
    plugin_artifact: String,

    #[arg(long)]
    loopback_binary_name: Option<String>,

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
async fn main() {
    if let Err(err) = run().await {
        eprintln!("Installation failed: {err:#}");
        #[cfg(windows)]
        show_windows_error_dialog(&format!("{err:#}"));
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let args = Args::parse();
    let owner_discord_id =
        resolve_owner_discord_id(args.owner_discord_id, args.relay_server_url.as_deref())?;
    let relay_server_url =
        resolve_relay_server_url(args.relay_server_url, owner_discord_id.relay_server_url);
    let loopback_artifact = args
        .loopback_artifact
        .as_deref()
        .unwrap_or(default_loopback_artifact_name());
    let loopback_binary_name = args
        .loopback_binary_name
        .unwrap_or_else(default_loopback_binary_name);
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
            relay_server_url.as_deref(),
        )?;
    } else {
        let client = build_client()?;
        let run_id = latest_successful_run(&client, &args.repo_owner, &args.repo_name).await?;
        let artifacts = list_artifacts(&client, &args.repo_owner, &args.repo_name, run_id).await?;

        let loopback_artifact = find_artifact(&artifacts, loopback_artifact)?;
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

        install_loopback_binary(&loopback_dir, &loopback_binary_name)?;
        let plugin_source = find_file_recursive(plugin_dir.path(), &args.plugin_file_name)?;
        install_plugin_into_vencord(
            &plugin_source,
            &args.plugin_file_name,
            &args.vencord_plugin_folder,
            relay_server_url.as_deref(),
        )?;
    }

    configure_loopback_startup(
        &owner_discord_id.owner_discord_id,
        relay_server_url.as_deref(),
    )?;

    println!("Installation complete.");
    Ok(())
}

#[derive(Debug)]
struct ResolvedOwner {
    owner_discord_id: String,
    relay_server_url: Option<String>,
}

#[cfg(not(windows))]
fn resolve_owner_discord_id(
    owner_discord_id: Option<String>,
    _relay_server_url: Option<&str>,
) -> Result<ResolvedOwner> {
    let owner_discord_id = owner_discord_id
        .ok_or_else(|| anyhow!("--owner-discord-id is required on this platform"))?;
    validate_owner_discord_id(&owner_discord_id)?;
    Ok(ResolvedOwner {
        owner_discord_id,
        relay_server_url: None,
    })
}

#[cfg(windows)]
fn resolve_owner_discord_id(
    owner_discord_id: Option<String>,
    relay_server_url: Option<&str>,
) -> Result<ResolvedOwner> {
    if let Some(owner_discord_id) = owner_discord_id {
        validate_owner_discord_id(&owner_discord_id)?;
        return Ok(ResolvedOwner {
            owner_discord_id,
            relay_server_url: None,
        });
    }
    collect_windows_wizard_inputs(relay_server_url)
}

fn resolve_relay_server_url(
    cli_relay_server_url: Option<String>,
    wizard_relay_server_url: Option<String>,
) -> Option<String> {
    cli_relay_server_url
        .or(wizard_relay_server_url)
        .or_else(|| Some(default_relay_server_url().to_string()))
}

#[cfg(windows)]
fn show_windows_error_dialog(message: &str) {
    let escaped = message.replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('{escaped}','Key Intercept Installer Error',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null"
    );
    let _ = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script)
        .status();
}

fn validate_owner_discord_id(owner_discord_id: &str) -> Result<()> {
    if owner_discord_id.is_empty() || !owner_discord_id.chars().all(|ch| ch.is_ascii_digit()) {
        bail!("owner Discord ID must contain only digits");
    }
    Ok(())
}

fn default_relay_server_url() -> &'static str {
    "https://82.165.196.147:45491"
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
    let target_dir = loopback_install_dir()?;
    fs::create_dir_all(&target_dir)
        .with_context(|| format!("failed to create {}", target_dir.display()))?;

    let target = loopback_binary_target_path()?;
    fs::copy(&source, &target).with_context(|| {
        format!(
            "failed to copy loopback binary from {} to {}",
            source.display(),
            target.display()
        )
    })?;

    ensure_loopback_binary_executable(&target)?;

    Ok(())
}

fn install_plugin_into_vencord(
    source: &Path,
    plugin_file_name: &str,
    plugin_folder: &str,
    relay_server_url: Option<&str>,
) -> Result<()> {
    let vencord_dir = ensure_vencord_checkout()?;
    sync_vencord_checkout(&vencord_dir)?;
    patch_vencord_csp(&vencord_dir, relay_server_url)?;
    ensure_pnpm_available()?;
    install_vencord_userplugin(source, &vencord_dir, plugin_folder, plugin_file_name)?;
    run_node_tool_in_dir("pnpm", &pnpm_install_args(), &vencord_dir)?;
    run_node_tool_in_dir("pnpm", &["build"], &vencord_dir)?;
    if let Err(err) = run_node_tool_in_dir("pnpm", &["inject"], &vencord_dir) {
        println!("Warning: `pnpm inject` failed: {err}");
        println!("The plugin may still work after running `pnpm inject` manually.");
    }

    Ok(())
}

fn patch_vencord_csp(vencord_dir: &Path, relay_server_url: Option<&str>) -> Result<()> {
    let Some(relay_url) = relay_server_url.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };

    let relay_origin = relay_origin_for_csp(relay_url)?;
    let csp_path = vencord_dir
        .join("src")
        .join("main")
        .join("csp")
        .join("index.ts");
    let mut csp_source = fs::read_to_string(&csp_path)
        .with_context(|| format!("failed to read {}", csp_path.display()))?;

    if csp_source.contains(&format!("\"{relay_origin}\": ConnectSrc")) {
        return Ok(());
    }

    let marker = "export const CspPolicies: PolicyMap = {\n";
    let insert =
        format!("{marker}    \"{relay_origin}\": ConnectSrc, // key-intercept relay server\n");
    if !csp_source.contains(marker) {
        bail!(
            "failed to patch {}, CspPolicies marker not found",
            csp_path.display()
        );
    }
    csp_source = csp_source.replacen(marker, &insert, 1);
    fs::write(&csp_path, csp_source)
        .with_context(|| format!("failed to write {}", csp_path.display()))?;
    Ok(())
}

fn relay_origin_for_csp(relay_server_url: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(relay_server_url)
        .with_context(|| format!("invalid --relay-server-url: {relay_server_url}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("relay URL has no host: {relay_server_url}"))?;
    let origin = match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    };
    Ok(origin)
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
    if node_tool_exists("pnpm") {
        return Ok(());
    }

    if !node_tool_exists("npm") {
        bail!("pnpm not found and npm is unavailable; install pnpm manually and rerun installer");
    }

    run_node_tool("npm", &["install", "-g", "pnpm"])
        .context("failed to install pnpm using npm install -g pnpm")
}

fn node_tool_exists(command: &str) -> bool {
    #[cfg(windows)]
    {
        return Command::new("cmd")
            .arg("/C")
            .arg(command)
            .arg("--version")
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        Command::new(command)
            .arg("--version")
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn run_node_tool(command: &str, args: &[&str]) -> Result<()> {
    #[cfg(windows)]
    {
        let status = Command::new("cmd")
            .arg("/C")
            .arg(command)
            .args(args)
            .status()
            .with_context(|| format!("failed to execute command `{command}`"))?;

        if !status.success() {
            bail!("command `{command}` failed with status {status}");
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        run_command(command, args)
    }
}

fn run_node_tool_in_dir(command: &str, args: &[&str], dir: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let status = Command::new("cmd")
            .current_dir(dir)
            .arg("/C")
            .arg(command)
            .args(args)
            .status()
            .with_context(|| format!("failed to execute command `{command}` in {}", dir.display()))?;

        if !status.success() {
            bail!(
                "command `{command}` in {} failed with status {status}",
                dir.display()
            );
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        run_command_in_dir(command, args, dir)
    }
}

fn install_vencord_userplugin(
    source_file: &Path,
    vencord_dir: &Path,
    plugin_folder: &str,
    plugin_file_name: &str,
) -> Result<()> {
    let destination_dir = vencord_dir
        .join("src")
        .join("userplugins")
        .join(plugin_folder);
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

#[cfg(windows)]
fn default_loopback_artifact_name() -> &'static str {
    "loopback-server-windows-x86_64"
}

#[cfg(target_os = "macos")]
fn default_loopback_artifact_name() -> &'static str {
    "loopback-server-macos-x86_64"
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_loopback_artifact_name() -> &'static str {
    "loopback-server-linux-x86_64"
}

fn default_loopback_binary_name() -> String {
    format!("loopback-server{EXE_SUFFIX}")
}

#[cfg(windows)]
fn loopback_install_dir() -> Result<PathBuf> {
    Ok(dirs::data_local_dir()
        .ok_or_else(|| anyhow!("could not determine local data directory"))?
        .join("Programs")
        .join("key-intercept"))
}

#[cfg(not(windows))]
fn loopback_install_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join(".local/bin"))
}

fn loopback_binary_target_path() -> Result<PathBuf> {
    Ok(loopback_install_dir()?.join(format!("key-intercept-loopback{EXE_SUFFIX}")))
}

#[cfg(unix)]
fn ensure_loopback_binary_executable(target: &Path) -> Result<()> {
    let mut perms = fs::metadata(target)
        .with_context(|| format!("failed to read {} metadata", target.display()))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(target, perms)
        .with_context(|| format!("failed to mark {} executable", target.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_loopback_binary_executable(_target: &Path) -> Result<()> {
    Ok(())
}

fn find_file_recursive(root: &Path, name: &str) -> Result<PathBuf> {
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() && entry.file_name().to_string_lossy() == name {
            return Ok(entry.path().to_path_buf());
        }
    }

    bail!("file '{name}' not found in artifact")
}

#[cfg(unix)]
fn configure_loopback_startup(
    owner_discord_id: &str,
    relay_server_url: Option<&str>,
) -> Result<()> {
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
    run_systemctl(["--user", "daemon-reload"])?;
    run_systemctl([
        "--user",
        "enable",
        "--now",
        "key-intercept-loopback.service",
    ])?;
    Ok(())
}

#[cfg(windows)]
fn configure_loopback_startup(
    owner_discord_id: &str,
    relay_server_url: Option<&str>,
) -> Result<()> {
    let startup_dir = windows_startup_dir()?;
    fs::create_dir_all(&startup_dir)
        .with_context(|| format!("failed to create {}", startup_dir.display()))?;

    let launcher_file = startup_dir.join("key-intercept-loopback.cmd");
    let loopback_binary = loopback_binary_target_path()?;
    let config_path = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not determine config directory"))?
        .join("key-intercept")
        .join("config.json");
    let mut script = format!(
        "@echo off\r\nset \"OWNER_DISCORD_ID={owner_discord_id}\"\r\nset \"LOOPBACK_PORT=35491\"\r\nset \"KEY_INTERCEPT_CONFIG_PATH={}\"\r\n",
        config_path.display()
    );
    if let Some(relay) = relay_server_url {
        script.push_str(&format!("set \"RELAY_SERVER_URL={relay}\"\r\n"));
    }
    script.push_str(&format!("start \"\" \"{}\"\r\n", loopback_binary.display()));

    fs::write(&launcher_file, script)
        .with_context(|| format!("failed to write {}", launcher_file.display()))?;

    Command::new("cmd")
        .arg("/C")
        .arg(&launcher_file)
        .spawn()
        .with_context(|| format!("failed to start loopback using {}", launcher_file.display()))?;

    Ok(())
}

#[cfg(windows)]
fn windows_startup_dir() -> Result<PathBuf> {
    let app_data =
        env::var_os("APPDATA").ok_or_else(|| anyhow!("APPDATA must be set on Windows"))?;
    Ok(PathBuf::from(app_data)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup"))
}

#[cfg(windows)]
fn collect_windows_wizard_inputs(relay_server_url: Option<&str>) -> Result<ResolvedOwner> {
    let default_relay_server_url = relay_server_url.unwrap_or(default_relay_server_url());
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = "Key Intercept Installer"
$form.StartPosition = "CenterScreen"
$form.Width = 480
$form.Height = 220
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$ownerLabel = New-Object System.Windows.Forms.Label
$ownerLabel.Left = 12
$ownerLabel.Top = 20
$ownerLabel.Width = 440
$ownerLabel.Text = "Owner Discord ID"
$form.Controls.Add($ownerLabel)

$ownerInput = New-Object System.Windows.Forms.TextBox
$ownerInput.Left = 12
$ownerInput.Top = 42
$ownerInput.Width = 440
$form.Controls.Add($ownerInput)

$relayLabel = New-Object System.Windows.Forms.Label
$relayLabel.Left = 12
$relayLabel.Top = 76
$relayLabel.Width = 440
$relayLabel.Text = "Relay server URL"
$form.Controls.Add($relayLabel)

$relayInput = New-Object System.Windows.Forms.TextBox
$relayInput.Left = 12
$relayInput.Top = 98
$relayInput.Width = 440
$relayInput.Text = $env:KEY_INTERCEPT_DEFAULT_RELAY_URL
$form.Controls.Add($relayInput)

$okButton = New-Object System.Windows.Forms.Button
$okButton.Text = "Install"
$okButton.Left = 276
$okButton.Top = 132
$okButton.Width = 84
$okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($okButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.Left = 368
$cancelButton.Top = 132
$cancelButton.Width = 84
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)

$form.AcceptButton = $okButton
$form.CancelButton = $cancelButton

if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    exit 2
}

$owner = $ownerInput.Text.Trim()
$relay = $relayInput.Text.Trim()
Write-Output $owner
Write-Output $relay
"#;

    let output = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script)
        .env(
            "KEY_INTERCEPT_DEFAULT_RELAY_URL",
            default_relay_server_url.to_string(),
        )
        .output()
        .context("failed to launch Windows installer wizard")?;

    if !output.status.success() {
        bail!("Windows installer wizard was cancelled");
    }

    let wizard_output = String::from_utf8(output.stdout)
        .context("failed to parse Windows installer wizard output")?;
    let mut lines = wizard_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let owner_discord_id = lines
        .next()
        .ok_or_else(|| anyhow!("Windows installer wizard did not return owner Discord ID"))?
        .to_string();
    validate_owner_discord_id(&owner_discord_id)?;

    let relay_server_url = lines.next().map(|value| value.to_string());

    Ok(ResolvedOwner {
        owner_discord_id,
        relay_server_url,
    })
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
        std::fs::write(
            source.path(),
            "export default definePlugin({ name: \"x\" });",
        )
        .unwrap();

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
    fn relay_origin_for_csp_preserves_scheme_host_and_port() {
        let origin = relay_origin_for_csp("http://82.165.196.147:45491").unwrap();
        assert_eq!(origin, "http://82.165.196.147:45491");
    }

    #[test]
    fn resolve_relay_server_url_prefers_cli_over_wizard_and_default() {
        let relay = resolve_relay_server_url(
            Some("https://cli.example".to_string()),
            Some("https://wizard.example".to_string()),
        );
        assert_eq!(relay.as_deref(), Some("https://cli.example"));
    }

    #[test]
    fn resolve_relay_server_url_uses_default_when_missing() {
        let relay = resolve_relay_server_url(None, None);
        assert_eq!(relay.as_deref(), Some(default_relay_server_url()));
    }

    #[test]
    fn validate_owner_discord_id_requires_digits() {
        assert!(validate_owner_discord_id("1234567890").is_ok());
        assert!(validate_owner_discord_id("12abc").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_owner_discord_id_is_required() {
        assert!(resolve_owner_discord_id(None, None).is_err());
        let resolved = resolve_owner_discord_id(Some("123456".to_string()), None).unwrap();
        assert_eq!(resolved.owner_discord_id, "123456");
    }

    #[test]
    fn patch_vencord_csp_adds_relay_connect_src_rule() {
        let vencord_dir = tempdir().unwrap();
        let csp_dir = vencord_dir.path().join("src").join("main").join("csp");
        std::fs::create_dir_all(&csp_dir).unwrap();
        let csp_file = csp_dir.join("index.ts");
        std::fs::write(
            &csp_file,
            "export const CspPolicies: PolicyMap = {\n    \"localhost:*\": ImageAndCssSrc,\n};\n",
        )
        .unwrap();

        patch_vencord_csp(vencord_dir.path(), Some("http://82.165.196.147:45491")).unwrap();

        let patched = std::fs::read_to_string(&csp_file).unwrap();
        assert!(patched.contains("\"http://82.165.196.147:45491\": ConnectSrc"));
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
