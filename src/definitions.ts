export interface CodePushPlugin {
  echo(options: { value: string }): Promise<{ value: string }>;
}
