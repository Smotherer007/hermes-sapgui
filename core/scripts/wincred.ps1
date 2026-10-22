# Reads a generic credential from Windows Credential Manager and prints the
# secret base64-encoded (UTF-8), so no console code page can mangle it.
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File wincred.ps1 -Target sapgui/DEV
#
# Store a password once with:   cmdkey /generic:sapgui/DEV /user:MYUSER /pass
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = 'Stop'

if (-not ('SapguiBridgeCred' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SapguiBridgeCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) { return null; }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0) { return ""; }
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
}
"@
}

$secret = [SapguiBridgeCred]::Read($Target)
if ($null -eq $secret) {
  [Console]::Error.WriteLine("No generic credential named '$Target' in Windows Credential Manager. Add it with: cmdkey /generic:$Target /user:<user> /pass")
  exit 2
}
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)))
