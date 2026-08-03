import { useState } from "react";
import { Play, AlertCircle } from "lucide-react";
import { Button } from "../base/Button.js";
import { Input } from "../base/Input.js";
import { Label } from "../base/Label.js";
import { Card, CardContent, CardHeader, CardTitle } from "../base/Card.js";

interface LegacyRunViewProps {
  isRunning: boolean;
  onStart: (repo: string, branch: string, prompt: string) => void;
}

export function LegacyRunView({ isRunning, onStart }: LegacyRunViewProps) {
  const [repo, setRepo] = useState("https://github.com/bezaspace/daybreak-target");
  const [branch, setBranch] = useState("main");
  const [prompt, setPrompt] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repo.trim() || isRunning) return;
    onStart(repo, branch, prompt);
  }

  return (
    <div className="space-y-4">
      <Card className="border-db-warning/30 bg-db-warning/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-db-warning">
            <AlertCircle className="h-4 w-4" />
            Legacy Run view
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-db-text-secondary">
            The chat composer is the new way to start sessions. This form is kept for compatibility.
          </p>
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
            <Label htmlFor="legacy-repo">Repo URL</Label>
            <Input
              id="legacy-repo"
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="Repo URL"
              disabled={isRunning}
            />
          </div>
          <div className="flex w-32 flex-col gap-1.5">
            <Label htmlFor="legacy-branch">Branch</Label>
            <Input
              id="legacy-branch"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="Branch"
              disabled={isRunning}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="legacy-prompt">Prompt (optional)</Label>
          <Input
            id="legacy-prompt"
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?"
            disabled={isRunning}
          />
        </div>
        <Button type="submit" disabled={isRunning || !repo.trim()}>
          {isRunning ? "Starting…" : <><Play className="h-4 w-4" />Run task</>}
        </Button>
      </form>
    </div>
  );
}
