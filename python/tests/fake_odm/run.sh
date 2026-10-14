#!/bin/sh
exec "$FAKE_ODM_PYTHON" "$(dirname "$0")/fake_odm.py" "$@"
