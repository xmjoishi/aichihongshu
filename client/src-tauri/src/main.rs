// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(debug_assertions)]
    let arguments: Vec<String> = std::env::args().collect();
    #[cfg(debug_assertions)]
    if arguments
        .get(1)
        .is_some_and(|argument| argument == "--native-host-fixture")
    {
        let Some(root) = arguments.get(2) else {
            eprintln!("native host fixture needs an output directory");
            std::process::exit(2);
        };
        match aichihongshu_lib::write_native_host_test_fixture(std::path::Path::new(root)) {
            Ok(path) => println!("{}", path.display()),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if is_native_host_invocation(std::env::args().skip(1)) {
        std::process::exit(aichihongshu_lib::run_native_messaging_host());
    }
    // Keep the executable path ASCII: macOS 27 Foundation crashes when scanning
    // a non-ASCII executable path. Set the user-facing name separately.
    #[cfg(target_os = "macos")]
    objc2_foundation::NSProcessInfo::processInfo()
        .setProcessName(&objc2_foundation::NSString::from_str("爱吃红薯"));
    aichihongshu_lib::run()
}

// Older registrations launched the executable directly: Chromium supplies the
// extension origin but ignores a manifest's nonstandard `args` field.
fn is_native_host_invocation(arguments: impl IntoIterator<Item = String>) -> bool {
    arguments.into_iter().any(|argument| {
        argument == "--native-messaging-host" || argument.starts_with("chrome-extension://")
    })
}

#[cfg(test)]
mod tests {
    use super::is_native_host_invocation;
    #[test]
    fn browser_origin_never_launches_gui_even_with_legacy_registration() {
        assert!(is_native_host_invocation([
            "chrome-extension://nafpjfbdjkcodifhhhkfnnciaonegbgk/".into()
        ]));
        assert!(is_native_host_invocation(
            ["--native-messaging-host".into()]
        ));
        assert!(!is_native_host_invocation(Vec::<String>::new()));
    }
}
