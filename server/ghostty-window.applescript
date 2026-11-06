-- Ported from Bot Crossing server/lib/ghostty-window.applescript (MIT, Jarren Rocks); see NOTICE.
-- Ghostty 1.3+ native API; never interpolate a session value into this source.
on run launchArguments
    set bundlePath to item 1 of launchArguments
    set workingDirectory to item 2 of launchArguments
    set launchCommand to item 3 of launchArguments
    using terms from application "Ghostty"
        tell application bundlePath
            set cfg to new surface configuration
            set initial working directory of cfg to workingDirectory
            set command of cfg to launchCommand
            set win to new window with configuration cfg
        end tell
    end using terms from
    return "agentville-window-created"
end run
