$cert = New-SelfSignedCertificate -DnsName "localhost" -CertStoreLocation "cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(2)
$thumb = $cert.Thumbprint
Write-Host "Thumbprint: $thumb"
$pwd = ConvertTo-SecureString "helmetai123" -Force -AsPlainText
$pfxPath = "D:\MCP Server\helmet-detection\.ssl-cert.pfx"
Export-PfxCertificate -Cert "cert:\CurrentUser\My\$thumb" -FilePath $pfxPath -Password $pwd | Out-Null
Write-Host "PFX exported to: $pfxPath"
