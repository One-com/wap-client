#!/usr/bin/env bash

# Bash strict mode (http://redsymbol.net/articles/unofficial-bash-strict-mode/)
set -euo pipefail
IFS=$'\n\t'

# This option requires bash 4.4+ It is enabled as otherwise, errors in subshells
# $() / `` will not cause the script to fail. We rely on subshells in this
# script and would like to know when they break... If you have to run this
# script locally and do not have access to a new enough bash, you can comment
# out the line below.
shopt -s inherit_errexit

# Directory name of the script https://stackoverflow.com/a/246128
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Allowlist of template variables substituted by generate-yaml.sh. Kept in sync
# with TEMPLATE_VARS there. Runtime shell vars used inside container commands
# (e.g. $PGUSER) are intentionally excluded — they are not render-time inputs.
TEMPLATE_VARS=(
  RELEASE_ENVIRONMENT
  K8S_NAMESPACE
  APP_IMAGE_NAME
  RELEASE_COMMIT_SHORT_SHA
  CONFIGMAP_HASH
)

function _print_variable_values {
  for VAR in "${TEMPLATE_VARS[@]}" ; do
    echo "${VAR}=$(printenv $VAR)"
  done
}

_print_variable_values
