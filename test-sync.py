import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sync_routes', Path(__file__).with_name('sync.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

class RouteValidation(unittest.TestCase):
    def base(self):
        home = {'nl': '/nl', 'en': '/en', 'default': '/en'}
        return [('/nl', home), ('/en', home)]

    def test_translated_slugs_and_singletons(self):
        pair = {'nl': '/nl/voorbeeld', 'en': '/en/example', 'default': '/en/example'}
        m = sync.compile_routes(self.base() + [('/nl/voorbeeld', pair), ('/en/example', pair), ('/en/only', {})])
        self.assertEqual(m['aliases']['/voorbeeld'], m['aliases']['/example'])
        self.assertEqual(m['groups'][m['aliases']['/only']], {'en': '/en/only'})

    def test_collision_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Ambiguous neutral alias'):
            sync.compile_routes(self.base() + [('/nl/shared', {}), ('/en/shared', {})])

    def test_missing_target_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Missing/nonreciprocal'):
            sync.compile_routes(self.base() + [('/nl/a', {'nl': '/nl/a', 'en': '/en/a'})])

    def test_external_url_rejected(self):
        with self.assertRaises(ValueError):
            sync.path_of('https://external.example/en')

    def test_entities_rejected(self):
        with self.assertRaises(ValueError):
            sync.load(b'<!DOCTYPE urlset [<!ENTITY x "test">]><urlset/>')

    def test_new_locale_rejected(self):
        xml = ('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
               '<url><loc>https://www.smaac.nl/nl</loc><xhtml:link rel="alternate" hreflang="fr" href="https://www.smaac.nl/fr"/></url></urlset>')
        with self.assertRaisesRegex(ValueError, 'New locale'):
            sync.load(xml.encode())

if __name__ == '__main__':
    unittest.main()
