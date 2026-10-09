//! A grouped bot update can change one git tag and leave two YARA-X versions
//! in Cargo.lock. The editor, include parser and compiler must share a release.

#[test]
fn yara_x_components_share_one_pinned_release() {
    let manifest: toml::Value = toml::from_str(include_str!("../Cargo.toml")).unwrap();
    let tag = format!("v{}", yara_x::VERSION);
    let repository = "https://github.com/VirusTotal/yara-x";
    for name in ["yara-x", "yara-x-parser", "yara-x-ls"] {
        let dependency = &manifest["dependencies"][name];
        assert_eq!(dependency["git"].as_str(), Some(repository), "{name}");
        assert_eq!(dependency["tag"].as_str(), Some(tag.as_str()), "{name}");
    }

    let lock: toml::Value = toml::from_str(include_str!("../Cargo.lock")).unwrap();
    let family: Vec<_> = lock["package"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|package| {
            let name = package["name"].as_str().unwrap();
            name == "yara-x" || name.starts_with("yara-x-")
        })
        .collect();
    let source = family[0]["source"].as_str().unwrap();
    assert!(source.starts_with(&format!("git+{repository}?tag={tag}#")));
    let mut names = std::collections::HashSet::new();
    for package in family {
        let name = package["name"].as_str().unwrap();
        assert!(names.insert(name), "duplicate YARA-X dependency: {name}");
        assert_eq!(package["version"].as_str(), Some(yara_x::VERSION), "{name}");
        assert_eq!(package["source"].as_str(), Some(source), "{name}");
    }
    for name in ["yara-x", "yara-x-parser", "yara-x-ls"] {
        assert!(names.contains(name), "missing YARA-X dependency: {name}");
    }
}
