export interface Job {
  id: string;
  name: string;
  durationMs: number;
}

export function JobRow({ job }: { job: Job }) {
  return (
    <tr>
      <td>{job.name}</td>
      <td>{job.durationMs} ms</td>
    </tr>
  );
}
