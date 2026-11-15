#!/usr/bin/env python3
"""App Sandbox と PTY / 外部 CLI の相性を調べる最小検証。アプリ本体の審査可否は判定しない。"""

import json
import pathlib
import platform
import plistlib
import shutil
import subprocess
import tempfile


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=60)


def main():
    if platform.system() != "Darwin":
        raise SystemExit("この検証は macOS と Xcode Command Line Tools が必要です。")

    project = pathlib.Path(__file__).resolve().parent.parent / "package.json"
    cli = shutil.which("claude")
    source = r'''
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  printf("HOME: %s\n", [NSHomeDirectory() UTF8String]);
  // 認証情報は参照しない。自分の package.json と実行ファイルのアクセス可否だけ確認する。
  FILE *f = fopen(@PROJECT@, "r");
  printf("unselected project read: %s (errno %d)\n", f ? "ALLOWED" : "DENIED", f ? 0 : errno);
  if (f) fclose(f);
  const char *cli = @CLI@;
  if (strlen(cli)) {
    int ok = access(cli, X_OK);
    printf("installed claude executable: %s (errno %d)\n", ok == 0 ? "ALLOWED" : "DENIED", ok == 0 ? 0 : errno);
  } else {
    puts("installed claude executable: NOT FOUND IN PATH");
  }
  // node-pty の macOS 実装と同じ PTY 割り当て API。シェルや Claude Code 自体は実行しない。
  int master = posix_openpt(O_RDWR);
  if (master < 0) { printf("posix_openpt: FAIL (%s)\n", strerror(errno)); return 0; }
  if (grantpt(master) < 0 || unlockpt(master) < 0) {
    printf("grantpt/unlockpt: FAIL (%s)\n", strerror(errno)); close(master); return 0;
  }
  char *name = ptsname(master);
  int slave = name ? open(name, O_RDWR) : -1;
  if (slave < 0) { printf("open slave: FAIL (%s)\n", strerror(errno)); close(master); return 0; }
  puts("PTY allocation: OK");
  close(slave); close(master); return 0;
}
'''.replace("@PROJECT@", json.dumps(str(project), ensure_ascii=False)).replace(
        "@CLI@", json.dumps(cli or "", ensure_ascii=False)
    )

    print(f"macOS {platform.mac_ver()[0]} / {platform.machine()}")
    with tempfile.TemporaryDirectory(prefix="noetelier-mas-probe-") as directory:
        root = pathlib.Path(directory)
        code = root / "probe.m"
        code.write_text(source)
        for label, entitlements in [
            ("baseline", {}),
            ("sandbox", {
                "com.apple.security.app-sandbox": True,
                "com.apple.security.files.user-selected.read-write": True,
                "com.apple.security.network.client": True,
            }),
        ]:
            app = root / f"{label}.app"
            macos = app / "Contents/MacOS"
            macos.mkdir(parents=True)
            binary = macos / "probe"
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": f"com.nomura.noetelier.probe.{label}",
                "CFBundleExecutable": "probe",
                "CFBundleName": "Noetelier MAS Probe",
                "CFBundlePackageType": "APPL",
                "CFBundleVersion": "1",
            }))
            rights = root / f"{label}.plist"
            rights.write_bytes(plistlib.dumps(entitlements))
            run(["xcrun", "clang", "-framework", "Foundation", str(code), "-o", str(binary)])
            # ローカルのアドホック署名。開発者の証明書・秘密鍵は不要。
            run(["codesign", "--force", "--sign", "-", "--entitlements", str(rights), str(app)])
            result = run([str(binary)])
            print(f"\n[{label}]\n{result.stdout}", end="")
            if label == "baseline" and "unselected project read: ALLOWED" not in result.stdout:
                raise SystemExit("通常実行の対照条件を確認できませんでした。")
            if label == "sandbox" and "unselected project read: DENIED" not in result.stdout:
                raise SystemExit("Sandbox のファイル制限を確認できませんでした。結果を採用しないでください。")
    print("\nこの結果は標準権限での最小検証です。MAS 版 Electron、権限取得後の子プロセス、CLI 認証、App Review は別途検証が必要です。")


if __name__ == "__main__":
    main()
