export async function genMessage(timestamp: number): Promise<string> {
    return `I agree to the Terms of Service at timestamp ${timestamp}`;
}
