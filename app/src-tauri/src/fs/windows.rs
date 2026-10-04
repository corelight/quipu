//! Windows conditional saves hold a handle with no sharing from comparison until
//! the write and flush finish. Ordinary readers, writers, deletes and renames
//! cannot open the file during that interval; an existing incompatible handle
//! makes Save fail before touching bytes. This also preserves the file's ACL,
//! identity and hard links. Pre-existing writable memory mappings are outside
//! this guarantee, as they can outlive the handles used to create them.
//!
//! Windows has no Unix-style atomic exchange. Writing through the held handle
//! means a crash can interrupt a save. Before changing bytes, we flush a recovery
//! copy beside the file, with the original DACL. Successful saves remove it;
//! failed writes restore through the same exclusive handle. If restoration fails
//! the error names the retained copy. After a crash, `.NAME.quipuPID-N.tmp` is the
//! original version and must be recovered manually. No startup cleanup deletes it.

use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind, Read, Seek, Write};
use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
use std::path::Path;

use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetKernelObjectSecurity, PROTECTED_DACL_SECURITY_INFORMATION,
    SetKernelObjectSecurity,
};
use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

use super::Saved;
use crate::project::escaped;

pub(crate) fn save(path: &Path, contents: &str, expect: Option<&str>) -> io::Result<Saved> {
    save_with(path, contents, expect, &mut overwrite)
}

fn save_with(
    path: &Path,
    contents: &str,
    expect: Option<&str>,
    write: &mut dyn FnMut(&mut File, &[u8]) -> io::Result<()>,
) -> io::Result<Saved> {
    // Canonicalization follows links; all version decisions are made on the
    // subsequently opened handle, never on an earlier metadata observation.
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut options = OpenOptions::new();
    options.read(true).write(true).share_mode(0);
    if expect.is_none() {
        options.create_new(true);
    }
    let mut file = match options.open(&path) {
        Ok(file) => file,
        Err(err) if expect.is_some() && err.kind() == ErrorKind::NotFound => {
            return Ok(Saved::Refused);
        }
        Err(err) if expect.is_none() && err.kind() == ErrorKind::AlreadyExists => {
            return Ok(Saved::Refused);
        }
        Err(err) => return Err(err),
    };
    let Some(want) = expect else {
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        return Ok(Saved::Written);
    };
    let mut found = Vec::new();
    file.read_to_end(&mut found)?;
    if found != want.as_bytes() {
        return Ok(Saved::Refused);
    }

    let (backup_path, mut backup) = super::temp_beside(&path)?;
    let prepared = copy_dacl(&file, &backup)
        .and_then(|()| backup.write_all(&found))
        .and_then(|()| backup.sync_all());
    if let Err(err) = prepared {
        drop(backup);
        let _ = std::fs::remove_file(&backup_path);
        return Err(err);
    }
    let result = write(&mut file, contents.as_bytes());
    if let Err(err) = result {
        if let Err(restore) = write(&mut file, &found) {
            return Err(io::Error::other(format!(
                "save failed ({err}); restoring the original also failed ({restore}); \
                 the original is kept at {}",
                escaped(&backup_path)
            )));
        }
        drop(backup);
        let _ = std::fs::remove_file(&backup_path);
        return Err(err);
    }
    drop(backup);
    let _ = std::fs::remove_file(&backup_path);
    Ok(Saved::Written)
}

fn overwrite(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.rewind()?;
    file.write_all(bytes)?;
    file.set_len(bytes.len() as u64)?;
    file.sync_all()
}

// Copy access restrictions before writing any original content to the recovery
// file. A temporary inheriting its directory's ACL could expose a private rule.
fn copy_dacl(from: &File, to: &File) -> io::Result<()> {
    let mut needed = 0;
    // SAFETY: both handles remain open, and needed is a valid output pointer.
    let ok = unsafe {
        GetKernelObjectSecurity(
            from.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if ok == 0
        && io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
    {
        return Err(io::Error::last_os_error());
    }
    // A self-relative security descriptor requires DWORD alignment.
    let mut descriptor = vec![0u32; (needed as usize).div_ceil(4)];
    // SAFETY: the aligned buffer has at least needed bytes and all pointers and
    // handles are valid for the duration of each call. Set does not retain it.
    unsafe {
        if GetKernelObjectSecurity(
            from.as_raw_handle(),
            DACL_SECURITY_INFORMATION,
            descriptor.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        if SetKernelObjectSecurity(
            to.as_raw_handle(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.as_mut_ptr().cast(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let mut text: Vec<u16> = path.as_os_str().encode_wide().collect();
        if text.contains(&0) {
            return Err(io::Error::new(ErrorKind::InvalidInput, "path contains NUL"));
        }
        text.push(0);
        Ok(text)
    }
    let source = wide(from)?;
    let destination = wide(to)?;
    // SAFETY: both paths are NUL-terminated and live through the call. Flags=0
    // refuses existing destinations and cross-volume copy/delete fallbacks.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) } == 0 {
        let err = io::Error::last_os_error();
        return Err(
            if err.kind() == ErrorKind::PermissionDenied && to.exists() {
                io::Error::from(ErrorKind::AlreadyExists)
            } else {
                err
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
