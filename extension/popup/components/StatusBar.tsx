import { cn } from "@/lib/utils";

interface StatusBarProps {
  message: string;
  type: "success" | "error";
}

export function StatusBar({ message, type }: StatusBarProps) {
  return (
    <div
      className={cn(
        "rounded-1 border p-1 text-center text-sm",
        type === "success" && "border-green-600 text-green-600",
        type === "error" && "border-destructive text-destructive",
      )}
    >
      {message}
    </div>
  );
}
