import UploadWizard from './UploadWizard';

export const dynamic = 'force-dynamic';

export default function NewImportPage() {
  return (
    <>
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Upload financial data</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          The file is analysed and validated first. Nothing is imported until you confirm.
        </p>
      </header>
      <UploadWizard />
    </>
  );
}
