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

##############################################################################
# Template variables
#
# Only these variables are substituted by envsubst. This is an explicit
# allowlist (rather than envsubst's auto-detection) so that runtime shell
# variables referenced inside container commands — e.g. $PGUSER / $PGPASSWORD in
# the `export DATABASE_URL=...` wrapper — are left untouched and expanded by the
# container at runtime, not at render time.

TEMPLATE_VARS=(
  RELEASE_ENVIRONMENT
  K8S_NAMESPACE
  APP_IMAGE_NAME
  RELEASE_COMMIT_SHORT_SHA
  CONFIGMAP_HASH
)

# envsubst restriction string, e.g. '${RELEASE_ENVIRONMENT} ${K8S_NAMESPACE} ...'
ENVSUBST_VARS=""
for VAR in "${TEMPLATE_VARS[@]}" ; do
  ENVSUBST_VARS="${ENVSUBST_VARS}\${${VAR}}"
done

###############################################################################
# VALIDATION
#
# Validate that the variables have sane values and that all necessary variables
# are configured.

# Check that all allowed variables have a value set
function _check_variable_values {
  local MISSING_VALUES=0

  for VAR in "${TEMPLATE_VARS[@]}" ; do
    if [[ -z "$(printenv $VAR)" ]] ; then
      echo "Environment variable ${VAR} should be set but was not!"

      MISSING_VALUES=$(( $MISSING_VALUES + 1 ))
    fi
  done

  return $MISSING_VALUES
}

_check_variable_values

# Validate that RELEASE_ENVIRONMENT is one of the supported values (or in other
# words; that there is a directory with the same name).
function _check_release_environment {
  if [[ "${RELEASE_ENVIRONMENT:0:7}" == "review-" ]] ; then
    # Use the `review` release environment for all release environments named
    # `rewiew-*`. This is to support `review-apps.
    TEMPLATE_DIR=review
    return 0
  fi

  local VALID_NAMES="$(find ${SCRIPT_DIR} -type d -mindepth 1 -exec basename {} \;)"

  for VALID_NAME in $VALID_NAMES ; do
    if [[ "${VALID_NAME}" == "${RELEASE_ENVIRONMENT}" ]] ; then
      # Found a match. The release environment is valid!
      return 0
    fi
  done

  echo "Unexpected value of RELEASE_ENVIRONMENT: ${RELEASE_ENVIRONMENT}"
  echo "Expected one of:" ${VALID_NAMES}
  return 1
}

TEMPLATE_DIR=${RELEASE_ENVIRONMENT}

_check_release_environment

###############################################################################
# GENERATION

# Concatenate a single yaml file from the appropriate folder.
for file in $(find ${SCRIPT_DIR}/${TEMPLATE_DIR} -type f -name '*.yaml' | sort) ; do
  # Write the yaml separator if it's not already in the file.
  [[ $(head -c 3 $file) != "---" ]] && echo '---'  ;

  # Restrict substitution to the allowlist so runtime shell vars ($PGUSER, ...)
  # inside container commands survive into the rendered manifest.
  envsubst "${ENVSUBST_VARS}" < $file ;
done
