#!/bin/sh

ID_VALUE="$(id)"

luna-send -n 1 -f luna://com.webos.notification/createToast "{\"message\":\"success execution with id: ${ID_VALUE}\"}"
