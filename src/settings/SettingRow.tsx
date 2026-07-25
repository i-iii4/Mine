interface SettingRowProps {
  label: string;
  caption?: string;
  children: React.ReactNode;
}

export function SettingRow({ label, caption, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-s3">
      <div className="min-w-0">
        <p className="text-base">{label}</p>
        {caption && <p className="text-sm text-muted-foreground">{caption}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
