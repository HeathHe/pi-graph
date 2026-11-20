import { hash, verify } from 'argon2';
export async function hashPassword(plain) {
    return hash(plain, {
        type: 2, // argon2id
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
    });
}
export async function verifyPassword(plain, hashed) {
    try {
        return await verify(hashed, plain);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=password.service.js.map