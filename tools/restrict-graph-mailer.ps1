<#
    Restrict the Best Gas Cash Collection mailer app so it can send mail ONLY
    from one mailbox.

    Microsoft Graph's application permission "Mail.Send" lets an app send as
    ANY mailbox in the tenant. That is far more than this app needs: it only
    ever sends notifications from GRAPH_SENDER. This script narrows it to that
    one mailbox, so a leaked client secret could not be used to send mail as
    anyone else in the company.

    Run this AFTER the app registration exists (you need its Application
    (client) ID), signed in as an Exchange administrator.

    Usage (Windows PowerShell, normal user is fine):
        cd C:\Users\User\Downloads\BestGas-Cash-Collection\tools
        .\restrict-graph-mailer.ps1 -AppId "<application-client-id>"

    Optional: -Mailbox someone.else@bestgas.sa   (defaults to m.mahdi@bestgas.sa)
#>
param(
    [Parameter(Mandatory = $true)][string]$AppId,
    [string]$Mailbox = 'm.mahdi@bestgas.sa'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
    Write-Host 'Installing the ExchangeOnlineManagement module (current user only)...' -ForegroundColor Cyan
    Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber
}
Import-Module ExchangeOnlineManagement

Write-Host 'A sign-in window will open. Sign in with an Exchange administrator account.' -ForegroundColor Cyan
Connect-ExchangeOnline -ShowBanner:$false

try {
    $already = Get-ApplicationAccessPolicy -ErrorAction SilentlyContinue |
               Where-Object { $_.AppId -eq $AppId }
    if ($already) {
        Write-Host 'A policy for this app already exists:' -ForegroundColor Yellow
        $already | Format-List AppId, ScopeName, AccessRight, Description
    }
    else {
        New-ApplicationAccessPolicy -AppId $AppId `
            -PolicyScopeGroupId $Mailbox `
            -AccessRight RestrictAccess `
            -Description "Best Gas Cash Collection mailer: may send only as $Mailbox" | Out-Null
        Write-Host "Policy created: the app may now send only as $Mailbox." -ForegroundColor Green
    }

    Write-Host ''
    Write-Host 'Verifying...' -ForegroundColor Cyan
    # Should say Granted: this is the mailbox the app is allowed to send from.
    $allowed = Test-ApplicationAccessPolicy -Identity $Mailbox -AppId $AppId
    Write-Host ("  {0,-34} {1}" -f $Mailbox, $allowed.AccessCheckResult)

    # Should say Denied: proof the app can no longer touch other mailboxes.
    $other = Get-Mailbox -ResultSize 5 |
             Where-Object { $_.PrimarySmtpAddress -ne $Mailbox } |
             Select-Object -First 1
    if ($other) {
        $denied = Test-ApplicationAccessPolicy -Identity $other.PrimarySmtpAddress -AppId $AppId
        Write-Host ("  {0,-34} {1}" -f $other.PrimarySmtpAddress, $denied.AccessCheckResult)
    }

    Write-Host ''
    Write-Host 'Note: the policy can take up to an hour to apply everywhere.' -ForegroundColor Yellow
    Write-Host 'If sending fails right after this, wait and run testMicrosoftMail again.' -ForegroundColor Yellow
}
catch {
    Write-Host ''
    Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    Write-Host 'If the error says ApplicationAccessPolicy is not recognised, your tenant' -ForegroundColor Yellow
    Write-Host 'uses the newer "RBAC for Applications" model instead. Equivalent commands:' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  $sp = New-ServicePrincipal -AppId "<app-id>" -ObjectId "<enterprise-app-object-id>"' -ForegroundColor Gray
    Write-Host '  New-ManagementScope -Name "BestGas mailer scope" `' -ForegroundColor Gray
    Write-Host ("      -RecipientRestrictionFilter ""PrimarySmtpAddress -eq '{0}'""" -f $Mailbox) -ForegroundColor Gray
    Write-Host '  New-ManagementRoleAssignment -App $sp.Identity -Role "Application Mail.Send" `' -ForegroundColor Gray
    Write-Host '      -CustomResourceScope "BestGas mailer scope"' -ForegroundColor Gray
}
finally {
    Disconnect-ExchangeOnline -Confirm:$false | Out-Null
}
