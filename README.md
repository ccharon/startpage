# Startpage

Startpage is a local bookmark start page. A single Go binary serves the page and your links on a
loopback address and stores them in one JSON file. The interface uses a CDE look with the colors of
the [Schiefer theme](https://github.com/ccharon/kde-schiefer-theme).

## Run

Building requires Go 1.27 or later and `make`. `make install` puts the binary into `~/.local/bin`
and the systemd user service into `~/.local/share/systemd/user`. Install and start it:

```bash
make install
systemctl --user daemon-reload
systemctl --user enable --now startpage
```

Then open `http://localhost:8765`. To use it as the browser start page, enter that address under
Firefox *Settings > Home > Custom URLs* or Chrome *Settings > On startup > Open a specific page*.
The log is in `journalctl --user -u startpage`.

In the page, the search field has focus and filters by title, URL and tags. Enter opens the first
match. Without a match, Enter opens the input as an address or searches the web. Bookmarks you open
often rank higher among matches of similar quality. Categories are moved by dragging their title
bar: the left or right edge of another category places them in the same row, the middle places them
in a row above or below. Every change can be undone with the *Undo* button in its notice or with
Ctrl+Z while the search field is empty.

A bookmarklet adds the page you are viewing, and the browser address bar can search the bookmarks.
Setup and behavior are described in [docs/browser-integration.md](docs/browser-integration.md).

`make` builds `bin/startpage-<os>-<arch>` for the current system. `make dist` builds all release
binaries without cgo, so they need no libraries, and writes `bin/SHA256SUMS`:

| File | System |
|------|--------|
| `startpage-linux-amd64` | Linux on x86-64 |
| `startpage-linux-arm64` | Linux on 64-bit ARM |
| `startpage-windows-amd64.exe` | Windows on x86-64, with console when started from a shell |
| `startpage-windows-amd64-noconsole.exe` | Windows on x86-64, never opens a console |

On Windows, run `make` from Git Bash. The data file and `startpage.log` are stored next to the
executable. To start it at login, place a shortcut to `startpage-windows-amd64-noconsole.exe` in the
folder that `Win+R` > `shell:startup` opens.

## Configuration

Command line flags:

| Flag       | Type   | Default                                   | Effect |
|------------|--------|-------------------------------------------|--------|
| `-addr`    | string | `127.0.0.1:8765`                          | Listen address. Only `localhost`, `127.0.0.1` and `::1` are accepted. |
| `-data`    | path   | `$XDG_DATA_HOME/startpage/bookmarks.json` | Data file. Falls back to `~/.local/share/startpage/` without `XDG_DATA_HOME`. |
| `-backups` | int    | `10`                                      | Number of rotating backups in `backups/` next to the data file. A save creates a backup of the previous state at most once per hour. `0` disables backups. |
| `-version` | bool   | `false`                                   | Print the version and exit. |

Flags for the service go into an override created with `systemctl --user edit startpage`:

```ini
[Service]
ExecStart=
ExecStart=%h/.local/bin/startpage -data %h/Nextcloud/startpage/bookmarks.json
```

Make variables for `make install` and `make uninstall`:

| Variable  | Type | Default                     | Effect |
|-----------|------|-----------------------------|--------|
| `PREFIX`  | path | `$(HOME)/.local`            | Base directory of the installation. |
| `BINDIR`  | path | `$(PREFIX)/bin`             | Target directory of the binary. |
| `UNITDIR` | path | `$(PREFIX)/share/systemd/user` | Target directory of the systemd user unit. |
| `DESTDIR` | path | empty                       | Staging root for packaging. |

Search engine, theme (auto, light, dark), font size and view are set in the page and stored in the
browser.

## Known limitations

- Search engine, theme, font size, view and collapsed categories are stored per browser profile.
  Another browser or profile starts with the defaults.
- The page loads favicons directly from `/favicon.ico` of every bookmarked site.
- Two tabs editing at the same time: the save of the second tab is rejected and that tab reloads,
  so its change is lost.
- There is no sync between devices. A data file in a synced folder works, but simultaneous edits on
  two devices are not merged.
- The server accepts connections from the local machine only. It has no login, so every user account on that machine can read and change the bookmarks through the port.
- Opening a bookmark from the page saves its usage counter, so the data file changes with every
  click. In a synced folder this causes a sync per click.
- If the data file is not valid JSON, the page shows the error in its banner and stays read-only until the file is repaired or replaced with a backup.
