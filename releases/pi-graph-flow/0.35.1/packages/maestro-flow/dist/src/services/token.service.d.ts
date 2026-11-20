export interface TokenPayload {
    sub: string;
    email: string;
    iat: number;
    exp: number;
}
export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}
export declare function generateAccessToken(userId: string, email: string): Promise<string>;
export declare function generateRefreshToken(userId: string, db: any): Promise<string>;
export declare function generateTokenPair(userId: string, email: string, db: any): Promise<TokenPair>;
export declare function verifyAccessToken(token: string): Promise<TokenPayload | null>;
export declare function rotateRefreshToken(oldToken: string, db: any): Promise<TokenPair | null>;
export declare function revokeRefreshToken(tokenHash: string, db: any): Promise<void>;
export declare function revokeAllUserTokens(userId: string, db: any): Promise<void>;
//# sourceMappingURL=token.service.d.ts.map