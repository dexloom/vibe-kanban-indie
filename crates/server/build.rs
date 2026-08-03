use std::{fs, path::Path};

fn main() {
    // Load .env from the workspace root so builds see local overrides.
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let env_file = workspace_root.join(".env");
    dotenv::from_path(&env_file).ok();
    if env_file.exists() {
        println!("cargo:rerun-if-changed={}", env_file.display());
    }

    // Create packages/local-web/dist directory if it doesn't exist so the
    // embedded asset build has something to read when the web app hasn't been
    // built yet (e.g. `cargo check` against a fresh checkout).
    let dist_path = Path::new("../../packages/local-web/dist");
    if !dist_path.exists() {
        println!("cargo:warning=Creating dummy packages/local-web/dist directory for compilation");
        fs::create_dir_all(dist_path).unwrap();

        // Create a dummy index.html
        let dummy_html = r#"<!DOCTYPE html>
<html><head><title>Build web app first</title></head>
<body><h1>Please build @vibe/local-web first</h1></body></html>"#;

        fs::write(dist_path.join("index.html"), dummy_html).unwrap();
    }
}
