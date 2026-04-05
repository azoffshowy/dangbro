#!/bin/sh
# root_persistence.sh
# Logging to /tmp/dangbro-root.log

LOGFILE="/tmp/dangbro-root.log"
: > "$LOGFILE"
APPID="com.webos.service.secondscreen.gateway"
SCRIPT_NAME="Dangbro Root"

IPK_URL="${IPK_URL:-https://github.com/webosbrew/webos-homebrew-channel/releases/download/v0.7.3/org.webosbrew.hbchannel_0.7.3_all.ipk}"
IPK_TMP="/tmp/hbchannel.ipk"
LUNA_FIFO="/tmp/dangbro-root.fifo"

HBC_SERVICE="/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service"
STARTUP_SRC="/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/startup.sh"

error_reason=""
devmode_state="unknown"
hbc_state="unknown"
devmode_removed=0

trap 'rm -f "$IPK_TMP" "$LUNA_FIFO"' EXIT

# ---------- logging / UI ----------

log() {
    echo "[$(date -Iseconds)] $*" >> "$LOGFILE"
}

send_toast() {
    log "Toast: ${1}"
    luna-send -w 2000 -a "${APPID}" -n 1 \
        'luna://com.webos.notification/createToast' \
        "$(printf '{"sourceId":"%s","message":"%s"}' "$APPID" "$1")" \
        >>"$LOGFILE" 2>&1 || true
}

get_webos_version() {
    luna-send -w 2000 -n 1 -q 'sdkVersion' -f \
        'luna://com.webos.service.tv.systemproperty/getSystemInfo' \
        '{"keys":["sdkVersion"]}' 2>>"$LOGFILE" \
        | sed -n -e 's/^\s*"sdkVersion":\s*"\([0-9.]\+\)"\s*,\?\s*$/\1/p'
}

# ---------- luna helpers ----------

# luna_subscribe_wait <uri> <payload> <grep_pattern>
# Subscribes to a luna service, blocks until a line matching grep_pattern
# appears in the stream, writes that line to stdout, returns 0.
# Returns 1 on timeout (luna-send -w controls the deadline).
luna_subscribe_wait() {
    local uri="$1" payload="$2" pattern="$3"
    local luna_pid result

    rm -f "$LUNA_FIFO" 2>>"$LOGFILE" || true
    mkfifo "$LUNA_FIFO" 2>>"$LOGFILE" || {
        log "Failed to create FIFO."
        return 1
    }

    luna-send -w 20000 -i "$uri" "$payload" >"$LUNA_FIFO" 2>>"$LOGFILE" &
    luna_pid="$!"

    if ! result="$(grep -m 1 -E "$pattern" -- "$LUNA_FIFO")"; then
        kill -TERM "$luna_pid" 2>/dev/null || true
        rm -f "$LUNA_FIFO" 2>>"$LOGFILE" || true
        return 1
    fi

    kill -TERM "$luna_pid" 2>/dev/null || true
    rm -f "$LUNA_FIFO" 2>>"$LOGFILE" || true
    echo "$result"
}

# ---------- dev mode ----------

enable_devmode() {
    local devdir="/var/luna/preferences/devmode_enabled"
    [ -d "$devdir" ] && { log "Dev mode already enabled."; return 0; }
    rm -f "$devdir" 2>>"$LOGFILE"  # remove if stale non-directory file
    mkdir -p "$devdir" 2>>"$LOGFILE" || {
        error_reason="Failed to enable Dev Mode"
        log "Failed to create devmode_enabled directory."
        return 1
    }
    log "Dev mode enabled."
}

get_devmode_state() {
    # Returns "true" if the LG Developer Mode app (com.palmdts.devmode) is
    # installed, "false" if not, "unknown" on error. Used only to decide
    # whether to attempt removal and whether to warn in the final alert.
    local out
    out="$(luna-send -w 2000 -n 1 -f \
        'luna://com.webos.applicationManager/getAppLoadStatus' \
        '{"appId":"com.palmdts.devmode"}' 2>>"$LOGFILE" || true)"
    printf '%s\n' "$out" | grep -q '"exist"[[:space:]]*:[[:space:]]*true' && { echo "true"; return; }
    printf '%s\n' "$out" | grep -q '"exist"[[:space:]]*:[[:space:]]*false' && { echo "false"; return; }
    echo "unknown"
}

remove_devmode_app() {
    log "Removing LG Dev Mode app."
    local result
    result="$(luna_subscribe_wait \
        'luna://com.webos.appInstallService/remove' \
        '{"id":"com.palmdts.devmode","subscribe":true}' \
        '"statusValue"[[:space:]]*:[[:space:]]*(31|25)([^0-9]|$)|Unknown method|"returnValue"[[:space:]]*:[[:space:]]*false'
    )" || { log "Dev Mode app removal timed out."; return 1; }

    printf '%s\n' "$result" | grep -q '"statusValue"[[:space:]]*:[[:space:]]*31\([^0-9]\|$\)' && {
        log "Dev Mode app removed successfully."
        return 0
    }

    log "Dev Mode app removal failed: ${result}"
    return 1
}

# ---------- homebrew channel ----------

check_hbc_installed() {
    if [ -x "$HBC_SERVICE" ] && [ -f "$STARTUP_SRC" ]; then
        log "Homebrew Channel service detected."
        return 0
    fi
    log "Homebrew Channel service not found (expected $HBC_SERVICE)."
    return 1
}

prepare_hbc_ipk() {
    log "Downloading Homebrew Channel IPK from ${IPK_URL}."
    send_toast "Downloading Homebrew Channel..."
    rm -f "$IPK_TMP" 2>>"$LOGFILE"
    if curl -L -o "$IPK_TMP" -- "$IPK_URL" >>"$LOGFILE" 2>&1; then
        log "IPK downloaded successfully."
        return 0
    fi
    error_reason="Failed to download Homebrew Channel IPK"
    log "Failed to download IPK."
    return 1
}

restart_appinstalld() {
    log "Restarting appinstalld."
    restart appinstalld >>"$LOGFILE" 2>&1 || log "Failed to restart appinstalld; continuing."
}

install_ipk() {
    log "Installing Homebrew Channel from ${IPK_TMP}."
    send_toast "Installing Homebrew Channel..."

    local result
    result="$(luna_subscribe_wait \
        'luna://com.webos.appInstallService/dev/install' \
        "$(printf '{"id":"com.ares.defaultName","ipkUrl":"%s","subscribe":true}' "$IPK_TMP")" \
        'installed|failed|Unknown method'
    )" || {
        error_reason="Homebrew Channel installation timed out"
        log "Installation timed out."
        return 1
    }

    case "$result" in
        *installed*)
            log "Installation reported success."
            return 0
            ;;
        *"Unknown method"*)
            error_reason="devmode_enabled was not recognized during installation"
            log "/dev/install response: ${result}"
            return 1
            ;;
        *)
            error_reason="Homebrew Channel installation failed"
            log "/dev/install response: ${result}"
            return 1
            ;;
    esac
}

ensure_hbc_installed() {
    if check_hbc_installed; then
        hbc_state="already_present"
        return 0
    fi

    log "Homebrew Channel missing; attempting installation."
    prepare_hbc_ipk || return 1

    for attempt in 1 2 3; do
        restart_appinstalld
        if install_ipk; then
            hbc_state="installed"
            return 0
        fi
        [ "$attempt" -eq 3 ] && { log "Retries exhausted."; return 1; }
        log "Install attempt ${attempt} failed; retrying in $((attempt * 2))s."
        sleep $((attempt * 2))
    done
}

run_elevation() {
    log "Executing elevate-service."
    "$HBC_SERVICE" >>"$LOGFILE" 2>&1 || {
        error_reason="Elevation failed"
        log "elevate-service failed."
        return 1
    }
    log "elevate-service completed."
}

# ---------- reporting ----------

upload_log() {
    local url
    url="$(curl -s --max-time 10 --data-binary @"$LOGFILE" 'https://paste.rs' 2>/dev/null)"
    case "$url" in
        https://paste.rs/*)
            log "Log uploaded: ${url}"
            echo "$url"
            return 0
            ;;
    esac
    log "Log upload failed or returned unexpected response."
    return 1
}

show_final_alert() {
    local outcome="$1"  # "success" or "failure"
    local base_msg base_instruction extra_msg message buttons

    if [ "$outcome" = "success" ]; then
        base_msg="Root setup complete."
        base_instruction="To keep root active you need to reboot the TV (QuickStart+ disabled). You can confirm root status in the HBC settings page."
        case "$hbc_state" in
            installed)       base_msg="${base_msg}<br>• Homebrew Channel: installed. OK" ;;
            already_present) base_msg="${base_msg}<br>• Homebrew Channel: already present. OK" ;;
        esac
        if [ "$devmode_removed" = "1" ]; then
            base_msg="${base_msg}<br>• Dev Mode app: removed. OK"
        elif [ "$devmode_state" = "false" ]; then
            base_msg="${base_msg}<br>• Dev Mode app: not found. OK"
        elif [ "$devmode_state" = "true" ]; then
            base_msg="${base_msg}<br>• Dev Mode app: still installed."
        fi
    else
        base_msg="Root setup failed."
        [ -n "$error_reason" ] && base_msg="${base_msg} Error: ${error_reason}."
        local log_url
        if [ -n "${UPLOAD_LOG}" ] && log_url="$(upload_log)"; then
            base_msg="${base_msg}<br>Log: ${log_url}"
        else
            base_msg="${base_msg} Check /tmp/dangbro-root.log for details."
        fi
    fi

    case "$devmode_state" in
        true)
            extra_msg="The LG Developer Mode app is still installed. Remove it manually before rebooting or root access may be lost."
            ;;
        unknown)
            extra_msg="Could not determine whether the LG Developer Mode app is still installed. Check it before rebooting or root access may be lost."
            ;;
        *)
            extra_msg=""
            ;;
    esac

    # Reboot shortcut only when root is confirmed set up and devmode app is absent
    if [ "$outcome" = "success" ] && [ "$devmode_state" = "false" ]; then
        buttons='[{"label":"Reboot now","onclick":"luna://com.webos.service.sleep/shutdown/machineReboot","params":{"reason":"remoteKey"}},{"label":"Don'\''t reboot"}]'
    else
        buttons='[{"label":"OK"}]'
    fi

    [ -n "$extra_msg" ] \
        && message="<h3>${SCRIPT_NAME}</h3><br>${base_msg}<br><br>${extra_msg}<br><br>${base_instruction}" \
        || message="<h3>${SCRIPT_NAME}</h3><br>${base_msg}<br><br>${base_instruction}"

    log "Creating final alert dialog."
    luna-send -w 2000 -a "$APPID" -n 1 \
        'luna://com.webos.notification/createAlert' \
        "$(printf '{"sourceId":"%s","message":"%s","buttons":%s}' "$APPID" "$message" "$buttons")" \
        >>"$LOGFILE" 2>&1 || true
}

# ---------- main ----------

log "===== dangbro-root start ====="
send_toast "Starting root setup."

if [ "$(id -u)" -ne 0 ]; then
    log "Root privileges required. Exiting."
    exit 1
fi
log "Root privileges confirmed."

webos_version="$(get_webos_version)"
if [ -n "$webos_version" ]; then
    log "webOS version: ${webos_version}"
else
    log "webOS version: unavailable"
fi

enable_devmode          || { show_final_alert "failure"; exit 1; }
ensure_hbc_installed    || { show_final_alert "failure"; exit 1; }
devmode_state="$(get_devmode_state)"
log "Dev Mode app state: ${devmode_state}"
run_elevation           || { show_final_alert "failure"; exit 1; }

if [ "$devmode_state" = "true" ]; then
    if remove_devmode_app; then
        devmode_state="false"
        devmode_removed=1
    else
        log "Dev Mode app removal failed; user must uninstall manually."
    fi
fi

show_final_alert "success"
log "===== dangbro-root finished successfully ====="
exit 0
