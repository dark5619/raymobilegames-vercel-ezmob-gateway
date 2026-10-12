' Grab A Toy - Vercel gateway settings
' Merge these changes into the existing source/AdConfig.brs.

function AD_GatewayBaseUrl() as string
    ' During first tests you may use the Vercel deployment URL, for example:
    ' return "https://YOUR-PROJECT.vercel.app/roku/vast"
    '
    ' Production preferred custom hostname:
    return "https://ads.raymobile.games/roku/vast"
end function

' IMPORTANT: BrightScript URLs do NOT use a backslash before ://.
function AD_GatewayConfigProblem(base as string) as string
    if base = invalid or base = "" then return "AD_GatewayBaseUrl is empty"
    if Instr(1, base, "YOUR_DEPLOYED_GATEWAY_HOST") > 0 then return "AD_GatewayBaseUrl still holds the placeholder host"
    if Instr(1, base, "?") > 0 then return "AD_GatewayBaseUrl must not contain a query string"

    lower = LCase(base)
    if Left(lower, 8) = "https://" then return ""

    if Left(lower, 7) = "http://"
        if AD_IsSideloaded() then return ""
        return "AD_GatewayBaseUrl must use https:// in a published build"
    end if

    return "AD_GatewayBaseUrl must start with https://"
end function

' In AD_BuildGatewayUrl(), use this privacy-safe IFA logic:
'
' if lmt = "0" and rida <> ""
'     url = url + "&ifa=" + rida.EncodeUriComponent()
' end if
' url = url + "&lmt=" + lmt
'
' Do not append ifa at all when lmt = "1".
