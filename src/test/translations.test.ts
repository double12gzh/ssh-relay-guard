import * as assert from 'assert';
import { dict, Lang } from '../panel/translations';

/**
 * Tests for i18n translations.
 * Ensures Chinese and English dictionaries stay in sync.
 */
suite('Translations', () => {

	test('zh and en should have identical keys', () => {
		const zhKeys = Object.keys(dict.zh).sort();
		const enKeys = Object.keys(dict.en).sort();

		assert.deepStrictEqual(zhKeys, enKeys, 'zh and en should have the same set of keys');
	});

	test('no translation value should be empty', () => {
		const langs: Lang[] = ['zh', 'en'];
		for (const lang of langs) {
			for (const [key, value] of Object.entries(dict[lang])) {
				assert.ok(
					typeof value === 'string' && value.length > 0,
					`dict.${lang}.${key} should not be empty`
				);
			}
		}
	});

	test('title should be consistent across languages', () => {
		assert.strictEqual(dict.zh.title, dict.en.title, 'Title should be the same in both languages');
	});
});
