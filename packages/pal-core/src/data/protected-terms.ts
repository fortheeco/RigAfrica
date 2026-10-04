// DATA ONLY: no logic. Guards (test/guards.test.ts) assert this module has no control flow.
// Protected categories and personal health data. Matched on word boundaries against `type` and
// `value` after normalisation. Deliberately broad: a false reject costs one claimed item; a false
// accept profiles someone on a protected attribute. See docs/DECISIONS.md D-016.
export const PROTECTED_TERMS: readonly string[] = [
  // category names (also catches invented feature types like "religion" or "ethnicity")
  'religion', 'religious', 'faith', 'ethnicity', 'ethnic', 'tribe', 'tribal', 'race', 'racial', 'caste',
  'political', 'politics', 'party member', 'partisan', 'sexual orientation', 'sexuality', 'gender identity',
  'health condition', 'medical', 'diagnosis', 'disability', 'disabled', 'biometric', 'fingerprint',
  'genetic', 'criminal record', 'immigration status', 'trade union membership',
  // religion
  'church', 'mosque', 'parish', 'diocese', 'imam', 'pastor', 'priest', 'bishop', 'christian', 'muslim',
  'islam', 'islamic', 'catholic', 'anglican', 'pentecostal', 'evangelical', 'methodist', 'baptist',
  'adventist', 'hindu', 'jewish', 'sikh', 'traditionalist', 'atheist', 'jumat', 'ramadan',
  'congregation', 'chaplain',
  // ethnicity (Nigeria, Kenya; non-exhaustive)
  'yoruba', 'igbo', 'hausa', 'fulani', 'ijaw', 'urhobo', 'itsekiri', 'edo', 'tiv', 'kanuri', 'ibibio',
  'kikuyu', 'luo', 'luhya', 'kalenjin', 'kamba', 'kisii', 'meru', 'maasai', 'somali', 'mijikenda', 'turkana',
  // politics (parties and roles)
  'apc', 'pdp', 'labour party', 'apga', 'nnpp', 'odm', 'uda', 'jubilee', 'azimio', 'kenya kwanza', 'wiper',
  'campaign volunteer', 'party agent', 'ward chairman', 'polling agent',
  // sexual orientation / gender identity
  'gay', 'lesbian', 'bisexual', 'lgbt', 'lgbtq', 'queer', 'transgender', 'heterosexual', 'homosexual',
  'intersex', 'nonbinary', 'non-binary',
  // gender (never inferred; only optional self-report outside extraction)
  'woman', 'women', 'female', 'male', 'men', 'girl', 'girls', 'boys', 'mother', 'father', 'widow',
  // personal health
  'hiv', 'aids', 'tuberculosis', 'diabetes', 'diabetic', 'cancer survivor', 'pregnant', 'pregnancy',
  'mental illness', 'depression', 'anxiety disorder', 'epilepsy', 'sickle cell', 'genotype', 'blood group',
  'patient', 'rehab',
];
