export const BASH_INTEGRATION = `# blockterm shell integration (bash)
if [ -z "\${BLOCKTERM_SHELL_INTEGRATION-}" ]; then
  BLOCKTERM_SHELL_INTEGRATION=1

  __blockterm_prompt_done="0"
  __blockterm_last_hist=""
  __blockterm_in_command="0"
  __blockterm_original_prompt_command="\${PROMPT_COMMAND-}"

  __blockterm_prompt_start() {
    builtin printf '\\e]133;A\\a'
  }

  __blockterm_prompt_end() {
    builtin printf '\\e]133;B\\a'
  }

  __blockterm_osc7() {
    builtin printf '\\e]7;file://%s%s\\a' "\${HOSTNAME-}" "$PWD"
  }

  __blockterm_restore_status() {
    return "$1"
  }

  __blockterm_update_prompt() {
    if [ -n "\${__blockterm_wrapped_ps1-}" ] && [ "$__blockterm_wrapped_ps1" = "\${PS1}" ]; then
      return 0
    fi
    __blockterm_wrapped_ps1="\\[$(__blockterm_prompt_start)\\]\${PS1}\\[$(__blockterm_prompt_end)\\]"
    PS1="$__blockterm_wrapped_ps1"
  }

  __blockterm_precmd() {
    __blockterm_status="$?"
    __blockterm_pipestatus=("\${PIPESTATUS[@]}")

    local __blockterm_hist="\${HISTCMD-}"
    local __blockterm_ran="0"
    if [ "$__blockterm_prompt_done" = "1" ]; then
      if [ "\${__blockterm_use_debug-0}" = "1" ]; then
        if [ "\${__blockterm_debug_ran-0}" = "1" ]; then
          __blockterm_ran="1"
        fi
      elif [ -z "$__blockterm_hist" ] || [ "$__blockterm_hist" != "\${__blockterm_last_hist-}" ]; then
        __blockterm_ran="1"
      fi
    fi
    __blockterm_debug_ran="0"
    __blockterm_last_hist="$__blockterm_hist"
    __blockterm_prompt_done="1"
    __blockterm_in_command="0"

    if [ -n "\${__blockterm_original_prompt_command-}" ]; then
      __blockterm_restore_status "$__blockterm_status"
      builtin eval "$__blockterm_original_prompt_command"
    fi

    if [ "$__blockterm_ran" = "1" ]; then
      builtin printf '\\e]133;D;%s\\a' "$__blockterm_status"
    fi
    __blockterm_osc7
    __blockterm_update_prompt
  }

  PROMPT_COMMAND=__blockterm_precmd

  # PS0 needs bash >= 4.4 (macOS ships 3.2). Otherwise chain a DEBUG trap instead.
  __blockterm_use_debug="0"
  if [ "\${BLOCKTERM_FORCE_BASH_DEBUG-}" = "1" ]; then
    __blockterm_use_debug="1"
  elif [ "\${BASH_VERSINFO[0]:-0}" -lt 4 ] || { [ "\${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "\${BASH_VERSINFO[1]:-0}" -lt 4 ]; }; then
    __blockterm_use_debug="1"
  fi

  if [ "$__blockterm_use_debug" = "1" ]; then
    __blockterm_preexec() {
      case "$BASH_COMMAND" in
        __blockterm_*) return 0 ;;
      esac
      if [ "$__blockterm_in_command" = "0" ]; then
        __blockterm_in_command="1"
        __blockterm_debug_ran="1"
        builtin printf '\\e]133;C\\a'
      fi
    }
    __blockterm_get_trap() {
      builtin local -a __blockterm_terms
      builtin eval "__blockterm_terms=( $(trap -p DEBUG) )"
      builtin printf '%s' "\${__blockterm_terms[2]:-}"
    }
    __blockterm_original_debug="$(__blockterm_get_trap)"
    __blockterm_debug_handler() {
      __blockterm_preexec
      if [ -n "$__blockterm_original_debug" ]; then
        builtin eval "$__blockterm_original_debug"
      fi
    }
    trap '__blockterm_debug_handler' DEBUG
  else
    PS0="\\[\\e]133;C\\a\\]\${PS0-}"
  fi

  __blockterm_update_prompt
fi
`;

export const ZSH_ENV = `# blockterm shell integration (zsh - zshenv)
if [ -z "\${BLOCKTERM_ENV_DONE-}" ]; then
  BLOCKTERM_ENV_DONE=1
  BLOCKTERM_USER_ZDOTDIR="\${BLOCKTERM_ORIG_ZDOTDIR:-$HOME}"
  if [ -f "$BLOCKTERM_USER_ZDOTDIR/.zshenv" ]; then
    ZDOTDIR="$BLOCKTERM_USER_ZDOTDIR"
    . "$BLOCKTERM_USER_ZDOTDIR/.zshenv"
  fi
  if [ -n "\${ZDOTDIR-}" ] && [ "$ZDOTDIR" != "\${BLOCKTERM_ZDOTDIR-}" ]; then
    BLOCKTERM_USER_ZDOTDIR="$ZDOTDIR"
  fi
  ZDOTDIR="\${BLOCKTERM_ZDOTDIR-}"
fi
`;

export const ZSH_PROFILE = `# blockterm shell integration (zsh - zprofile)
if [ -z "\${BLOCKTERM_PROFILE_DONE-}" ]; then
  BLOCKTERM_PROFILE_DONE=1
  BLOCKTERM_USER_ZDOTDIR="\${BLOCKTERM_USER_ZDOTDIR:-\${BLOCKTERM_ORIG_ZDOTDIR:-$HOME}}"
  if [ -f "$BLOCKTERM_USER_ZDOTDIR/.zprofile" ]; then
    ZDOTDIR="$BLOCKTERM_USER_ZDOTDIR"
    . "$BLOCKTERM_USER_ZDOTDIR/.zprofile"
  fi
  ZDOTDIR="\${BLOCKTERM_ZDOTDIR-}"
fi
`;

export const ZSH_LOGIN = `# blockterm shell integration (zsh - zlogin)
if [ -z "\${BLOCKTERM_LOGIN_DONE-}" ]; then
  BLOCKTERM_LOGIN_DONE=1
  BLOCKTERM_USER_ZDOTDIR="\${BLOCKTERM_USER_ZDOTDIR:-\${BLOCKTERM_ORIG_ZDOTDIR:-$HOME}}"
  ZDOTDIR="$BLOCKTERM_USER_ZDOTDIR"
  if [ -f "$ZDOTDIR/.zlogin" ]; then
    . "$ZDOTDIR/.zlogin"
  fi
fi
`;

export const ZSH_RC_HEADER = `# blockterm shell integration (zsh - zshrc)
if [ -z "\${BLOCKTERM_SHELL_INTEGRATION-}" ]; then
  BLOCKTERM_SHELL_INTEGRATION=1
  BLOCKTERM_USER_ZDOTDIR="\${BLOCKTERM_USER_ZDOTDIR:-\${BLOCKTERM_ORIG_ZDOTDIR:-$HOME}}"

  if [ -n "\${HISTFILE-}" ] && [ -n "\${BLOCKTERM_ZDOTDIR-}" ]; then
    case "$HISTFILE" in
      "\${BLOCKTERM_ZDOTDIR}"/*) HISTFILE="\${BLOCKTERM_USER_ZDOTDIR}/.zsh_history" ;;
    esac
  fi

  if [ -f "\${BLOCKTERM_USER_ZDOTDIR}/.zshrc" ]; then
    ZDOTDIR="\${BLOCKTERM_USER_ZDOTDIR}"
    . "\${BLOCKTERM_USER_ZDOTDIR}/.zshrc"
  fi
fi
`;

export const ZSH_RC_FOOTER = `if [[ "\${options[login]-off}" == "off" ]]; then
  ZDOTDIR="\${BLOCKTERM_USER_ZDOTDIR:-\${BLOCKTERM_ORIG_ZDOTDIR:-$HOME}}"
fi`;

export const ZSH_INTEGRATION = `# blockterm shell integration (zsh - hooks)
if [ -z "\${BLOCKTERM_HOOKS_DONE-}" ]; then
  BLOCKTERM_HOOKS_DONE=1
  autoload -Uz add-zsh-hook

  __blockterm_command_ran="0"

  __blockterm_prompt_start() {
    builtin printf '\\e]133;A\\a'
  }

  __blockterm_prompt_end() {
    builtin printf '\\e]133;B\\a'
  }

  __blockterm_osc7() {
    builtin printf '\\e]7;file://%s%s\\a' "\${HOST-}" "$PWD"
  }

  __blockterm_preexec() {
    __blockterm_command_ran="1"
    builtin printf '\\e]133;C\\a'
  }

  __blockterm_precmd() {
    local __blockterm_status="$?"
    if [ "$__blockterm_command_ran" = "1" ]; then
      builtin printf '\\e]133;D;%s\\a' "$__blockterm_status"
      __blockterm_command_ran="0"
    fi
    __blockterm_osc7
    if [[ "$PS1" != *'133;A'* ]]; then
      PS1="%{$(__blockterm_prompt_start)%}\${PS1}%{$(__blockterm_prompt_end)%}"
    fi
  }

  add-zsh-hook precmd __blockterm_precmd
  add-zsh-hook preexec __blockterm_preexec
fi
`;

export const PWSH_INTEGRATION = `# blockterm shell integration (pwsh)
if (-not $global:__blockterm_integrated) {
  $global:__blockterm_integrated = $true

  $global:__blockterm_command_ran = $false
  $global:__blockterm_prompted = $false
  $global:__blockterm_has_psreadline = $false
  $global:__blockterm_last_history = 0
  $global:__blockterm_previous_exit = 0
  $global:__blockterm_original_prompt = $function:prompt

  function global:prompt {
    $blocktermSuccess = $global:?
    $blocktermLastExit = $LASTEXITCODE
    $result = ''

    if (-not $global:__blockterm_has_psreadline) {
      $blocktermHistory = @(Get-History).Count
      if ($global:__blockterm_prompted -and $blocktermHistory -gt $global:__blockterm_last_history) {
        $result += "$([char]27)]133;C$([char]7)"
        $global:__blockterm_command_ran = $true
      }
      $global:__blockterm_last_history = $blocktermHistory
    }

    if ($global:__blockterm_command_ran) {
      $code = 0
      # Success only if $? is true AND LASTEXITCODE is fresh (unset/0/unchanged since last prompt).
      # Native commands keep the previous LASTEXITCODE and (before PS 7.4 default) leave $? true.
      $blocktermOk = $blocktermSuccess -and (
        $null -eq $blocktermLastExit -or
        $blocktermLastExit -eq 0 -or
        $blocktermLastExit -eq $global:__blockterm_previous_exit
      )
      if (-not $blocktermOk) {
        if ($null -ne $blocktermLastExit -and $blocktermLastExit -ne 0 -and $blocktermLastExit -ne $global:__blockterm_previous_exit) {
          $code = $blocktermLastExit
        } else {
          $code = 1
        }
      }
      $global:__blockterm_previous_exit = $blocktermLastExit
      $result += "$([char]27)]133;D;$code$([char]7)"
      $global:__blockterm_command_ran = $false
    }

    $hostName = "$env:COMPUTERNAME"
    try { $hostName = [System.Net.Dns]::GetHostName() } catch { }
    $path = $PWD.Path.Replace('\\', '/')
    if (-not $path.StartsWith('/')) { $path = '/' + $path }
    $result += "$([char]27)]7;file://$hostName$path$([char]7)"

    $result += "$([char]27)]133;A$([char]7)"

    if (-not $blocktermSuccess) { Write-Error 'failure' -ErrorAction Ignore }
    $global:LASTEXITCODE = $blocktermLastExit

    if ($global:__blockterm_original_prompt) {
      $result += (& $global:__blockterm_original_prompt)
    } else {
      $result += "PS $($ExecutionContext.SessionState.Path.CurrentLocation)> "
    }
    $result += "$([char]27)]133;B$([char]7)"

    $global:__blockterm_prompted = $true
    return $result
  }

  Import-Module PSReadLine -ErrorAction SilentlyContinue
  if (Get-Module -Name PSReadLine) {
    $global:__blockterm_has_psreadline = $true
    $global:__blockterm_original_readline = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
      $line = if ($global:__blockterm_original_readline) {
        $global:__blockterm_original_readline.Invoke()
      } else {
        ''
      }
      if ($line -and "$line".Trim().Length -gt 0) {
        $global:__blockterm_command_ran = $true
        [Console]::Write("$([char]27)]133;C$([char]7)")
      }
      $line
    }
  }
}
`;
