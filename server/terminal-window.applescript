-- Terminal.app fallback. The command is a process argument, never part of this source.
on run launchArguments
    set launchCommand to item 1 of launchArguments
    tell application "Terminal"
        activate
        do script launchCommand
    end tell
    return "agentville-window-created"
end run
