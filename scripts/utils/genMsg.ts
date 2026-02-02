export async function genMessage(timestamp: number): Promise<string> {
  return `By proceeding with creating a new contract, I agree to 10102's Terms of Service at timestamp ${timestamp}.`;
}
