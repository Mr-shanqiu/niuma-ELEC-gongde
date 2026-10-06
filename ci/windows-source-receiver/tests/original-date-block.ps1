  $expires=[DateTimeOffset]::MinValue
  if ($binding.expiresAtUtc -cnotmatch '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\z' -or
      -not [DateTimeOffset]::TryParse($binding.expiresAtUtc,[Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal,[ref]$expires) -or
      $expires -le [DateTimeOffset]::UtcNow -or $expires -gt [DateTimeOffset]::UtcNow.AddDays(7)) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('OWNER_BINDING_EXPIRED')
  }

