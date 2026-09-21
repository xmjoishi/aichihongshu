fn main() {
    // Match Noomd: refresh embedded dev icons whenever platform assets change.
    for icon in [
        "icons/icon.icns",
        "icons/icon.ico",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }
    tauri_build::build()
}
