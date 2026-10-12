/**
 * One password policy, used everywhere a password is set, so signup and
 * reset can never drift apart. Length matters far more than character
 * mixing (NIST SP 800-63B), but a light complexity check also catches the
 * most common weak choices without being so strict it pushes people
 * toward "Password1!"-style patterns.
 */
import { registerDecorator, ValidationOptions } from 'class-validator';

export const PASSWORD_MIN_LENGTH = 12;

const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;
const HAS_SYMBOL = /[^A-Za-z0-9]/;

export function passwordPolicyErrors(password: string): string[] {
  const errors: string[] = [];
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
  const classes = [HAS_LOWER, HAS_UPPER, HAS_DIGIT, HAS_SYMBOL].filter((re) => re.test(password ?? ''));
  if (classes.length < 3) {
    errors.push('Password must include at least three of: lowercase letters, uppercase letters, numbers, symbols.');
  }
  return errors;
}

export function isPasswordValid(password: string): boolean {
  return passwordPolicyErrors(password).length === 0;
}

/** class-validator decorator wrapping the policy above, so DTOs get one clear error message. */
export function IsStrongPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options: {
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include at least three of: lowercase, uppercase, numbers, symbols.`,
        ...validationOptions,
      },
      validator: { validate: (value: unknown) => typeof value === 'string' && isPasswordValid(value) },
    });
  };
}
