import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

interface FormPanelProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  danger?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}

export default function FormPanel({ icon: Icon, title, description, danger, style, children }: FormPanelProps) {
  return (
    <section className="glass-panel" style={danger ? { borderColor: "var(--danger)", ...style } : style}>
      <h3 className="glass-panel-heading">
        <Icon size={18} />
        {title}
      </h3>
      {description && <p className="glass-panel-desc">{description}</p>}
      {children}
    </section>
  );
}
