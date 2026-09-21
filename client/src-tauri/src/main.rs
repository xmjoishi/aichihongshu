// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Keep the executable path ASCII: macOS 27 Foundation crashes when scanning
    // a non-ASCII executable path. Set the user-facing name separately.
    #[cfg(target_os = "macos")]
    objc2_foundation::NSProcessInfo::processInfo()
        .setProcessName(&objc2_foundation::NSString::from_str("爱吃红薯"));
    aichihongshu_lib::run()
}
