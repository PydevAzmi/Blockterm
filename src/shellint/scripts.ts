export const BASH_INTEGRATION = `# blockterm shell integration (bash)
if [ -z "\${BLOCKTERM_SHELL_INTEGRATION-}" ]; then
  BLOCKTERM_SHELL_INTEGRATION=1

  __blockterm_in_command="1"
  __blockterm_prompt_done="0"
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

  __blockterm_update_prompt() {
    if [ -n "\${__blockterm_wrapped_ps1-}" ] && [ "$__blockterm_wrapped_ps1" = "\${PS1}" ]; then
      return 0
    fi
    __blockterm_wrapped_ps1="\\[$(__blockterm_prompt_start)\\]\${PS1}\\[$(__blockterm_prompt_end)\\]"
    PS1="$__blockterm_wrapped_ps1"
  }

  __blockterm_preexec() {
    if [ "$__blockterm_in_command" = "0" ]; then
      __blockterm_in_command="1"
      builtin printf '\\e]133;C\\a'
    fi
  }

  __blockterm_precmd() {
    __blockterm_status="$?"
    if [ -n "\${__blockterm_original_prompt_command-}" ]; then
      builtin eval "$__blockterm_original_prompt_command"
    fi
    if [ "$__blockterm_prompt_done" = "1" ]; then
      builtin printf '\\e]133;D;%s\\a' "$__blockterm_status"
    fi
    __blockterm_prompt_done="1"
    __blockterm_osc7
    __blockterm_update_prompt
    __blockterm_in_command="0"
  }

  PROMPT_COMMAND=__blockterm_precmd
  trap '__blockterm_preexec' DEBUG

  __blockterm_update_prompt
fi
`;

export const ZSH_INTEGRATION = `# blockterm shell integration (zsh)
if [ -z "\${BLOCKTERM_SHELL_INTEGRATION-}" ]; then
  BLOCKTERM_SHELL_INTEGRATION=1
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
if (-not $env:BLOCKTERM_SHELL_INTEGRATION) {
  $env:BLOCKTERM_SHELL_INTEGRATION = '1'

  if ($PROFILE -and (Test-Path -LiteralPath $PROFILE)) {
    . $PROFILE
  }

  $global:__blockterm_command_ran = $false
  $global:__blockterm_prompted = $false
  $global:__blockterm_has_psreadline = $false
  $global:__blockterm_original_prompt = $function:prompt

  function global:prompt {
    $ok = $?
    $lastExit = $LASTEXITCODE
    $result = ''

    if (-not $global:__blockterm_has_psreadline -and $global:__blockterm_prompted) {
      $result += "$([char]27)]133;C$([char]7)"
      $global:__blockterm_command_ran = $true
    }

    if ($global:__blockterm_command_ran) {
      $code = 0
      if (-not $ok) {
        if ($lastExit -ne 0) { $code = $lastExit } else { $code = 1 }
      }
      $result += "$([char]27)]133;D;$code$([char]7)"
      $global:__blockterm_command_ran = $false
    }

    $hostName = "$env:COMPUTERNAME"
    try { $hostName = [System.Net.Dns]::GetHostName() } catch { }
    $path = $PWD.Path.Replace('\\', '/')
    if (-not $path.StartsWith('/')) { $path = '/' + $path }
    $result += "$([char]27)]7;file://$hostName$path$([char]7)"

    $result += "$([char]27)]133;A$([char]7)"
    if ($global:__blockterm_original_prompt) {
      $result += (& $global:__blockterm_original_prompt)
    } else {
      $result += "PS $($ExecutionContext.SessionState.Path.CurrentLocation)> "
    }
    $result += "$([char]27)]133;B$([char]7)"

    $global:__blockterm_prompted = $true
    return $result
  }

  if (Get-Module -ListAvailable -Name PSReadLine) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
    if (Get-Module -Name PSReadLine) {
      $global:__blockterm_has_psreadline = $true
      Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        $global:__blockterm_command_ran = $true
        [Console]::Write("$([char]27)]133;C$([char]7)")
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
      }
    }
  }
}
`;
