interface PlaceholderProps {
  title: string;
  children?: React.ReactNode;
}

export function Placeholder({ title, children }: PlaceholderProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-db-text-secondary">
      <h3 className="mb-1 font-medium text-db-text">{title}</h3>
      {children || <p>Not available.</p>}
    </div>
  );
}
