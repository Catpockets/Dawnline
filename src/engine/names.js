// ---------------------------------------------------------------------------
// Procedural identities. Name pools deliberately span many cultures so the
// population feels like humanity, not one village. Children inherit their
// father's surname when known, otherwise their mother's.
// ---------------------------------------------------------------------------
import { pick } from './rng.js';

export const MALE_NAMES = [
  'Amir', 'Bjorn', 'Chen', 'Diego', 'Emeka', 'Farid', 'Goran', 'Hiro', 'Ivan', 'Jamal',
  'Kofi', 'Luca', 'Mateo', 'Nikolai', 'Omar', 'Pavel', 'Quang', 'Ravi', 'Santiago', 'Tariq',
  'Umar', 'Viktor', 'Wei', 'Xavier', 'Yusuf', 'Zhen', 'Arjun', 'Dmitri', 'Enzo', 'Hassan',
  'Idris', 'Joon', 'Kenji', 'Leif', 'Marco', 'Nnamdi', 'Otto', 'Pedro', 'Rashid', 'Stefan',
  'Takeshi', 'Ulf', 'Vikram', 'Werner', 'Yannick', 'Zoltan', 'Anders', 'Bruno', 'Carlos', 'Dae',
  'Elias', 'Femi', 'Gustav', 'Henrik', 'Ismail', 'Jorge', 'Kwame', 'Liang', 'Mikhail', 'Nuno'
];

export const FEMALE_NAMES = [
  'Aisha', 'Bianca', 'Chioma', 'Daniela', 'Elena', 'Fatima', 'Greta', 'Hana', 'Ingrid', 'Jasmine',
  'Keiko', 'Leila', 'Mei', 'Nadia', 'Olga', 'Priya', 'Qi', 'Rosa', 'Sofia', 'Tala',
  'Uma', 'Valentina', 'Wren', 'Xiu', 'Yuki', 'Zara', 'Amara', 'Beatriz', 'Carmen', 'Devi',
  'Esther', 'Freya', 'Gabriela', 'Halima', 'Ines', 'Jin', 'Katya', 'Lucia', 'Marisol', 'Naomi',
  'Oksana', 'Paloma', 'Rina', 'Sana', 'Thea', 'Ulla', 'Vera', 'Willa', 'Yasmin', 'Zainab',
  'Anya', 'Brigitta', 'Camille', 'Dalia', 'Emiko', 'Farah', 'Gita', 'Hilde', 'Imani', 'Jana'
];

export const SURNAMES = [
  'Okafor', 'Tanaka', 'Silva', 'Petrov', 'Nguyen', 'Haddad', 'Kowalski', 'Ademola', 'Rossi', 'Kimura',
  'Osei', 'Vargas', 'Lindqvist', 'Sharma', 'Castillo', 'Dubois', 'Eriksson', 'Farouk', 'Gonzalez', 'Hansen',
  'Ibrahim', 'Jansen', 'Kaur', 'Lopez', 'Mbeki', 'Nakamura', 'Olsen', 'Popov', 'Quraishi', 'Ramirez',
  'Sato', 'Toure', 'Ueda', 'Volkov', 'Watanabe', 'Xu', 'Yamamoto', 'Zhao', 'Abara', 'Bergman',
  'Cruz', 'Diallo', 'Endo', 'Fischer', 'Garcia', 'Hussein', 'Ito', 'Johansson', 'Khan', 'Larsen',
  'Mensah', 'Novak', 'Obi', 'Park', 'Reyes', 'Suzuki', 'Tran', 'Umeh', 'Vasquez', 'Weber'
];

export function firstNameFor(rand, sex) {
  return pick(rand, sex === 'F' ? FEMALE_NAMES : MALE_NAMES);
}
export function surname(rand) {
  return pick(rand, SURNAMES);
}
export function fullName(a) {
  return a.firstName + ' ' + a.lastName;
}
