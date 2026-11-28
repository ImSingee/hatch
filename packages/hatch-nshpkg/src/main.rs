//! `hatch-nshpkg`: the platform's signing tool for native App packages.
//!
//! A build (the Builder or `hatch app deploy --local`) signs its `.nshpkg`
//! with a throwaway key of its own; the platform never trusts that key. When
//! the platform accepts the build it extracts the package's files into an
//! unsigned *package input* (`extract`), with the capabilities the platform
//! derived itself. Each time a deployment becomes live the platform builds a
//! new package from that input with the activation's build number and signs
//! it with its release key (`pack`). The code is the same bytes every time:
//! a rollback ships the older code under a newer build, which shells accept.
//!
//! Every command prints one JSON object to stdout. A refused input exits 3
//! with `{"error":{"code","message"}}`, a usage error exits 2, anything else
//! exits 1. Secret keys are read from files and never printed.

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use nsh_package::{
    App, Certificate, Contents, PublicKey, Revocations, SecretKey, TrustStore, build, certify,
    revoke, verify_signature,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

/// The QuickJS bytecode format of the NSH 0.7.0 runtime. Packages carry
/// bytecode only for this version; the version of `nsh-package` pins it.
const BYTECODE_VERSION: &str = "quickjs-ng-0.16.2+0fdea21/bc28/le";
const NSH_PACKAGE_VERSION: &str = nsh_package::RUNTIME_VERSION;
/// The format of the package input directory (`package-input.json`).
const INPUT_FORMAT: &str = "hatch-nsh-package-input-v1";
const INPUT_FILE: &str = "package-input.json";
const FILES_DIR: &str = "files";

enum Failure {
    /// Bad command line.
    Usage(String),
    /// The input is not acceptable (a package, a mismatch).
    Refused(&'static str, String),
    /// Anything else.
    Internal(String),
}

type Result<T> = std::result::Result<T, Failure>;

fn refused(code: &'static str, message: impl Into<String>) -> Failure {
    Failure::Refused(code, message.into())
}

fn internal(message: impl std::fmt::Display) -> Failure {
    Failure::Internal(message.to_string())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("version") => Ok(json!({
            "nshPackage": NSH_PACKAGE_VERSION,
            "bytecodeVersion": BYTECODE_VERSION,
            "inputFormat": INPUT_FORMAT,
        })),
        Some("keygen") => Flags::parse(&args[1..]).and_then(|f| keygen(&f)),
        Some("extract") => Flags::parse(&args[1..]).and_then(|f| extract(&f)),
        Some("pack") => Flags::parse(&args[1..]).and_then(|f| pack(&f)),
        Some("verify") => Flags::parse(&args[1..]).and_then(|f| verify(&f)),
        _ => Err(Failure::Usage(
            "usage: hatch-nshpkg version | keygen | extract | pack | verify".into(),
        )),
    };
    match result {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(failure) => {
            let (code, message, exit) = match failure {
                Failure::Usage(m) => ("usage", m, 2),
                Failure::Refused(c, m) => (c, m, 3),
                Failure::Internal(m) => ("internal", m, 1),
            };
            println!(
                "{}",
                json!({ "error": { "code": code, "message": message } })
            );
            ExitCode::from(exit)
        }
    }
}

/// `--name value` pairs and positional arguments.
struct Flags {
    values: Vec<(String, String)>,
    positional: Vec<String>,
}

impl Flags {
    fn parse(args: &[String]) -> Result<Flags> {
        let mut flags = Flags {
            values: Vec::new(),
            positional: Vec::new(),
        };
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            if let Some(name) = arg.strip_prefix("--") {
                let value = iter
                    .next()
                    .ok_or_else(|| Failure::Usage(format!("--{name} needs a value")))?;
                if flags.values.iter().any(|(n, _)| n == name) {
                    return Err(Failure::Usage(format!("--{name} is given twice")));
                }
                flags.values.push((name.to_owned(), value.clone()));
            } else {
                flags.positional.push(arg.clone());
            }
        }
        Ok(flags)
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    fn required(&self, name: &str) -> Result<&str> {
        self.get(name)
            .ok_or_else(|| Failure::Usage(format!("--{name} is required")))
    }

    fn path(&self, name: &str) -> Result<PathBuf> {
        self.required(name).map(PathBuf::from)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|e| internal(format!("{}: {e}", path.display())))
}

fn read_text(path: &Path) -> Result<String> {
    fs::read_to_string(path).map_err(|e| internal(format!("{}: {e}", path.display())))
}

/// Writes a new file (never replaces one) with `mode`.
fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .map_err(|e| internal(format!("{}: {e}", path.display())))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| internal(format!("{}: {e}", path.display())))
}

/// Creates `dir`, which must not exist yet, private to its owner.
fn create_private_dir(dir: &Path) -> Result<()> {
    fs::create_dir(dir).map_err(|e| internal(format!("{}: {e}", dir.display())))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| internal(format!("{}: {e}", dir.display())))
}

/// The same rule `nsh-package` applies to asset paths: relative, `/`
/// separated, no empty, `.` or `..` segment, no `\`, `:` or NUL.
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

// ---------------------------------------------------------------- keygen

/// Creates a key set in `--out` (a new directory): a root key, a release
/// key the root certifies for `--apps` for `--days`, and the root's first
/// revocation list (sequence 1, empty). The caller moves the directory into
/// place in one rename, so a set is never half written.
fn keygen(flags: &Flags) -> Result<Value> {
    let out = flags.path("out")?;
    let apps = flags.required("apps")?.to_owned();
    let days: u64 = flags
        .required("days")?
        .parse()
        .map_err(|_| Failure::Usage("--days must be a number".into()))?;
    if days == 0 || days > 36_500 {
        return Err(Failure::Usage("--days must be 1 to 36500".into()));
    }
    let root = SecretKey::generate().map_err(internal)?;
    let release = SecretKey::generate().map_err(internal)?;
    let not_before = now().saturating_sub(300);
    let not_after = now() + days * 86_400;
    let certificate = certify(
        &root,
        &release.public(),
        std::slice::from_ref(&apps),
        not_before,
        not_after,
    );
    let revocations = revoke(&root, 1, &[], &[]);
    let release_id = release.public().id();

    create_private_dir(&out)?;
    let releases = out.join("release");
    create_private_dir(&releases)?;
    write_new(&out.join("root.secret"), root.to_base64().as_bytes(), 0o600)?;
    write_new(
        &out.join("root.pub"),
        root.public().to_base64().as_bytes(),
        0o644,
    )?;
    write_new(
        &releases.join(format!("{release_id}.secret")),
        release.to_base64().as_bytes(),
        0o600,
    )?;
    write_new(
        &releases.join(format!("{release_id}.pub")),
        release.public().to_base64().as_bytes(),
        0o644,
    )?;
    write_new(
        &releases.join(format!("{release_id}.cert")),
        certificate.to_json().as_bytes(),
        0o644,
    )?;
    write_new(
        &out.join("revocations.json"),
        revocations.to_json().as_bytes(),
        0o644,
    )?;
    let state = json!({
        "format": 1,
        "rootKeyId": root.public().id(),
        "activeReleaseKeyId": release_id,
        "releaseKeys": [{
            "id": release_id,
            "apps": [apps],
            "notBefore": not_before,
            "notAfter": not_after,
            "createdAt": now(),
        }],
        "revocationSequence": 1,
    });
    write_new(
        &out.join("state.json"),
        serde_json::to_vec_pretty(&state).expect("json").as_slice(),
        0o644,
    )?;
    Ok(state)
}

// ---------------------------------------------------------------- extract

/// One file of a package input.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InputFile {
    path: String,
    /// `source`, `bytecode`, `sourceMap` or `asset`.
    kind: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InputApp {
    id: String,
    name: String,
    version: String,
}

/// `package-input.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    format: String,
    nsh_package: String,
    app: InputApp,
    min_runtime: String,
    /// The capabilities the platform derived; never the build's.
    capabilities: Value,
    /// Present with a `bytecode` file.
    bytecode_version: Option<String>,
    files: Vec<InputFile>,
}

/// Reads the header JSON without trusting it (for fields `nsh-package`
/// keeps private, the bytecode version): `NSHP`, format, flags, length.
fn raw_header(bytes: &[u8]) -> Result<Value> {
    if bytes.len() < 12 || &bytes[..4] != b"NSHP" {
        return Err(refused("invalid_package", "not an nsh package"));
    }
    let len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let header = bytes
        .get(12..12usize.saturating_add(len))
        .ok_or_else(|| refused("invalid_package", "the header length is out of range"))?;
    serde_json::from_slice(header)
        .map_err(|e| refused("invalid_package", format!("the header is not JSON: {e}")))
}

fn mismatch(field: &str, expected: &str, got: &str) -> Failure {
    refused(
        "mismatch",
        format!("the package's {field} is {got}, the platform expects {expected}"),
    )
}

/// Opens a build's package (signed by the build's own throwaway root,
/// `--root`), checks it is exactly the App the platform expects and writes
/// its files as a package input to `--out` (a new directory), with the
/// capabilities from `--capabilities` (which the package must declare
/// exactly). Its bytecode is kept: shells load it as trusted input, and the
/// platform trusts whoever may deploy the App with it.
fn extract(flags: &Flags) -> Result<Value> {
    let bytes = read(&flags.path("package")?)?;
    let root = PublicKey::from_base64(read_text(&flags.path("root")?)?.trim())
        .map_err(|e| refused("invalid_package", format!("the build's root key: {e}")))?;
    let expected_capabilities: Value =
        serde_json::from_str(&read_text(&flags.path("capabilities")?)?)
            .map_err(|e| Failure::Usage(format!("--capabilities is not JSON: {e}")))?;
    if !expected_capabilities.is_object() {
        return Err(Failure::Usage(
            "--capabilities must be a JSON object".into(),
        ));
    }
    let id = flags.required("id")?;
    let name = flags.required("name")?;
    let version = flags.required("app-version")?;
    let min_runtime = flags.required("min-runtime")?;
    let out = flags.path("out")?;

    let header = raw_header(&bytes)?;
    // The signature against its own certificate first: the bytes arrived
    // intact and the file table is the one that was signed.
    let signed = verify_signature(&bytes).map_err(|e| {
        refused(
            "invalid_package",
            format!("the package does not verify: {e}"),
        )
    })?;
    let mut store = TrustStore::new();
    store.add_root(root);
    let package = store.verify(&bytes, BYTECODE_VERSION).map_err(|e| {
        refused(
            "invalid_package",
            format!("the package does not verify: {e}"),
        )
    })?;
    if !package.ignored.is_empty() {
        return Err(refused(
            "invalid_package",
            format!(
                "the package has fields this platform does not know: {}",
                package.ignored.join(", ")
            ),
        ));
    }
    if package.app.id != id {
        return Err(mismatch("app id", id, &package.app.id));
    }
    if package.app.name != name {
        return Err(mismatch("app name", name, &package.app.name));
    }
    if package.app.version != version {
        return Err(mismatch("app version", version, &package.app.version));
    }
    if signed.min_runtime() != min_runtime {
        return Err(mismatch(
            "minimum runtime",
            min_runtime,
            signed.min_runtime(),
        ));
    }
    // A package that declares nothing may do anything: the declaration must
    // be present and exactly the platform's.
    match &package.capabilities {
        Some(declared) if *declared == expected_capabilities => {}
        Some(declared) => {
            return Err(refused(
                "mismatch",
                format!(
                    "the package declares capabilities {declared}, the platform derived \
                     {expected_capabilities} from the committed manifest"
                ),
            ));
        }
        None => {
            return Err(refused(
                "mismatch",
                "the package declares no capabilities (which would allow everything)",
            ));
        }
    }
    let header_bytecode = header
        .get("bytecodeVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let has_bytecode_file = header
        .get("files")
        .and_then(Value::as_array)
        .is_some_and(|files| {
            files
                .iter()
                .any(|f| f.get("kind").and_then(Value::as_str) == Some("bytecode"))
        });
    if has_bytecode_file && package.bytecode().is_none() {
        return Err(refused(
            "mismatch",
            format!(
                "the package's bytecode is for {header_bytecode}, this platform runs \
                 {BYTECODE_VERSION}"
            ),
        ));
    }
    for (path, _) in &package.assets {
        if !safe_relative(path) {
            return Err(refused(
                "invalid_package",
                format!("invalid asset path `{path}`"),
            ));
        }
    }

    // Written to a new directory, files first and the description last.
    create_private_dir(&out)?;
    let files_dir = out.join(FILES_DIR);
    create_private_dir(&files_dir)?;
    let mut files = Vec::new();
    let mut put = |path: &str, kind: &str, data: &[u8]| -> Result<()> {
        let target = files_dir.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(internal)?;
        }
        write_new(&target, data, 0o644)?;
        files.push(InputFile {
            path: path.to_owned(),
            kind: kind.to_owned(),
            size: data.len() as u64,
            sha256: sha256(data),
        });
        Ok(())
    };
    put("bundle.js", "source", package.source.as_bytes())?;
    let bytecode = package.bytecode();
    if let Some(bytecode) = bytecode {
        put("bundle.nshc", "bytecode", bytecode)?;
    }
    if let Some(map) = &package.source_map {
        put("bundle.js.map", "sourceMap", map.as_bytes())?;
    }
    for (path, data) in &package.assets {
        put(&format!("assets/{path}"), "asset", data)?;
    }
    let input = Input {
        format: INPUT_FORMAT.to_owned(),
        nsh_package: NSH_PACKAGE_VERSION.to_owned(),
        app: InputApp {
            id: id.to_owned(),
            name: name.to_owned(),
            version: version.to_owned(),
        },
        min_runtime: min_runtime.to_owned(),
        capabilities: expected_capabilities,
        bytecode_version: bytecode.map(|_| BYTECODE_VERSION.to_owned()),
        files,
    };
    write_new(
        &out.join(INPUT_FILE),
        serde_json::to_vec_pretty(&input).expect("json").as_slice(),
        0o644,
    )?;
    Ok(serde_json::to_value(&input).expect("json"))
}

// ---------------------------------------------------------------- pack

/// Reads a package input and checks every file against its hash.
fn read_input(dir: &Path) -> Result<(Input, Contents)> {
    let input: Input = serde_json::from_str(&read_text(&dir.join(INPUT_FILE))?)
        .map_err(|e| refused("invalid_input", format!("{INPUT_FILE}: {e}")))?;
    if input.format != INPUT_FORMAT {
        return Err(refused(
            "invalid_input",
            format!("{INPUT_FILE} is {}, not {INPUT_FORMAT}", input.format),
        ));
    }
    if input.nsh_package != NSH_PACKAGE_VERSION {
        return Err(refused(
            "invalid_input",
            format!(
                "the input was extracted for nsh-package {}, this tool is {NSH_PACKAGE_VERSION}",
                input.nsh_package
            ),
        ));
    }
    let mut source = None;
    let mut bytecode = None;
    let mut source_map = None;
    let mut assets = Vec::new();
    for file in &input.files {
        if !safe_relative(&file.path) {
            return Err(refused(
                "invalid_input",
                format!("invalid path `{}`", file.path),
            ));
        }
        let data = read(&dir.join(FILES_DIR).join(&file.path))?;
        if data.len() as u64 != file.size || sha256(&data) != file.sha256 {
            return Err(refused(
                "invalid_input",
                format!("`{}` does not match its hash", file.path),
            ));
        }
        let twice = || refused("invalid_input", format!("two {} files", file.kind));
        match file.kind.as_str() {
            "source" => {
                if source.is_some() {
                    return Err(twice());
                }
                source = Some(
                    String::from_utf8(data)
                        .map_err(|_| refused("invalid_input", "the source is not UTF-8"))?,
                );
            }
            "bytecode" => {
                if bytecode.is_some() {
                    return Err(twice());
                }
                let version = input.bytecode_version.clone().ok_or_else(|| {
                    refused("invalid_input", "bytecode without a bytecode version")
                })?;
                bytecode = Some((data, version));
            }
            "sourceMap" => {
                if source_map.is_some() {
                    return Err(twice());
                }
                source_map = Some(
                    String::from_utf8(data)
                        .map_err(|_| refused("invalid_input", "the source map is not UTF-8"))?,
                );
            }
            "asset" => {
                let path = file
                    .path
                    .strip_prefix("assets/")
                    .filter(|p| safe_relative(p))
                    .ok_or_else(|| {
                        refused(
                            "invalid_input",
                            format!("asset outside assets/: {}", file.path),
                        )
                    })?;
                assets.push((path.to_owned(), data));
            }
            other => {
                return Err(refused(
                    "invalid_input",
                    format!("unknown file kind `{other}`"),
                ));
            }
        }
    }
    let source = source.ok_or_else(|| refused("invalid_input", "the input has no source"))?;
    if !input.capabilities.is_object() {
        return Err(refused(
            "invalid_input",
            "the input declares no capabilities",
        ));
    }
    let contents = Contents {
        app: App {
            id: input.app.id.clone(),
            name: input.app.name.clone(),
            version: input.app.version.clone(),
            build: 0,
        },
        capabilities: Some(input.capabilities.clone()),
        source,
        bytecode,
        source_map,
        assets,
        min_runtime: Some(input.min_runtime.clone()),
    };
    Ok((input, contents))
}

/// Builds a package from the package input in `--input` with build number
/// `--build`, signed by the release key `--key` that `--cert` certifies, and
/// writes it to `--out` (a new file). `--id` and `--app-version` must be the
/// input's. With `--root`, the result is verified against it first.
fn pack(flags: &Flags) -> Result<Value> {
    let dir = flags.path("input")?;
    let id = flags.required("id")?;
    let version = flags.required("app-version")?;
    let build_number: u64 = flags
        .required("build")?
        .parse()
        .map_err(|_| Failure::Usage("--build must be a positive integer".into()))?;
    if build_number == 0 {
        return Err(Failure::Usage("--build must be a positive integer".into()));
    }
    let key = SecretKey::from_base64(read_text(&flags.path("key")?)?.trim())
        .map_err(|e| internal(format!("release key: {e}")))?;
    let certificate = Certificate::from_json(&read_text(&flags.path("cert")?)?)
        .map_err(|e| internal(format!("certificate: {e}")))?;
    let out = flags.path("out")?;

    let (input, mut contents) = read_input(&dir)?;
    if input.app.id != id {
        return Err(mismatch("app id", id, &input.app.id));
    }
    if input.app.version != version {
        return Err(mismatch("app version", version, &input.app.version));
    }
    contents.app.build = build_number;
    let bytes = build(&contents, &key, &certificate).map_err(internal)?;
    if let Some(root) = flags.get("root") {
        let root = PublicKey::from_base64(read_text(Path::new(root))?.trim()).map_err(internal)?;
        let mut store = TrustStore::new();
        store.add_root(root);
        store
            .verify(&bytes, BYTECODE_VERSION)
            .map_err(|e| internal(format!("the new package does not verify: {e}")))?;
    }
    write_new(&out, &bytes, 0o644)?;
    let header = raw_header(&bytes)?;
    Ok(json!({
        "sha256": sha256(&bytes),
        "size": bytes.len(),
        "build": build_number,
        "keyId": key.public().id(),
        "createdAt": header.get("createdAt").cloned().unwrap_or(Value::Null),
        "bytecode": contents.bytecode.is_some(),
    }))
}

// ---------------------------------------------------------------- verify

/// An exclusive hold on a trust state directory, released when dropped.
struct StateLock(PathBuf);

impl StateLock {
    fn take(dir: &Path) -> Result<StateLock> {
        fs::create_dir_all(dir).map_err(internal)?;
        let file = dir.join(".hatch-nshpkg.lock");
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    refused(
                        "state_in_use",
                        format!(
                            "another verify uses {} (remove {} if none runs)",
                            dir.display(),
                            file.display()
                        ),
                    )
                } else {
                    internal(format!("{}: {e}", file.display()))
                }
            })?;
        Ok(StateLock(file))
    }
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Verifies packages in order as a shell trusting `--root` would, accepting
/// each one that verifies: later packages with older builds are refused.
/// `--revocations` applies a revocation list; `--state` keeps the store's
/// accepted builds across runs. Prints one result per package, with the
/// SHA-256 of each file it holds.
fn verify(flags: &Flags) -> Result<Value> {
    let root = PublicKey::from_base64(read_text(&flags.path("root")?)?.trim())
        .map_err(|e| Failure::Usage(format!("--root: {e}")))?;
    if flags.positional.is_empty() {
        return Err(Failure::Usage("name at least one package".into()));
    }
    // One run at a time per state directory: each run reads the accepted
    // builds once and saves them whole, so two at once could lower them.
    let _lock = match flags.get("state") {
        Some(dir) => Some(StateLock::take(Path::new(dir))?),
        None => None,
    };
    let mut store = match flags.get("state") {
        Some(dir) => TrustStore::open(dir).map_err(internal)?,
        None => TrustStore::new(),
    };
    store.add_root(root);
    if let Some(list) = flags.get("revocations") {
        let list = Revocations::from_json(&read_text(Path::new(list))?)
            .map_err(|e| Failure::Usage(format!("--revocations: {e}")))?;
        match store.update_revocations(list) {
            Ok(_) => {}
            // The store already has this list or a newer one.
            Err(nsh_package::Error::StaleRevocations { .. }) => {}
            Err(error) => {
                return Err(refused(
                    "invalid_revocations",
                    format!("the revocation list cannot be applied: {error}"),
                ));
            }
        }
    }
    let mut results = Vec::new();
    for path in &flags.positional {
        let bytes = read(Path::new(path))?;
        match store.verify(&bytes, BYTECODE_VERSION) {
            Ok(package) => {
                store.accept(&package).map_err(internal)?;
                let mut files = vec![json!({
                    "path": "bundle.js", "kind": "source",
                    "sha256": sha256(package.source.as_bytes()),
                })];
                if let Some(bytecode) = package.bytecode() {
                    files.push(json!({
                        "path": "bundle.nshc", "kind": "bytecode", "sha256": sha256(bytecode),
                    }));
                }
                if let Some(map) = &package.source_map {
                    files.push(json!({
                        "path": "bundle.js.map", "kind": "sourceMap",
                        "sha256": sha256(map.as_bytes()),
                    }));
                }
                for (asset, data) in &package.assets {
                    files.push(json!({ "path": asset, "kind": "asset", "sha256": sha256(data) }));
                }
                results.push(json!({
                    "path": path,
                    "ok": true,
                    "app": package.app,
                    "capabilities": package.capabilities,
                    "sha256": package.sha256,
                    "keyId": package.key_id,
                    "createdAt": package.created_at,
                    "files": files,
                }));
            }
            Err(error) => results.push(json!({
                "path": path,
                "ok": false,
                "error": error.to_string(),
            })),
        }
    }
    Ok(json!({ "results": results }))
}
