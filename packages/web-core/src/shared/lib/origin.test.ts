import { describe, it, expect } from 'vitest';
import { parseAllowedOriginsCsv } from './origin';

describe('parseAllowedOriginsCsv', () => {
  it('parses a single http URL', () => {
    const { values, error } = parseAllowedOriginsCsv(
      'http://192.168.1.50:3001'
    );
    expect(error).toBeNull();
    expect(values).toEqual(['http://192.168.1.50:3001']);
  });

  it('parses multiple comma-separated entries with whitespace', () => {
    const { values, error } = parseAllowedOriginsCsv(
      'http://a.example:3001, https://b.example ,http://c.example'
    );
    expect(error).toBeNull();
    expect(values).toEqual([
      'http://a.example:3001',
      'https://b.example',
      'http://c.example',
    ]);
  });

  it('drops empty entries from trailing/adjacent commas', () => {
    const { values, error } = parseAllowedOriginsCsv(
      'http://a.example,,,http://b.example,'
    );
    expect(error).toBeNull();
    expect(values).toEqual(['http://a.example', 'http://b.example']);
  });

  it('returns empty list with no error for an empty CSV', () => {
    const { values, error } = parseAllowedOriginsCsv('');
    expect(error).toBeNull();
    expect(values).toEqual([]);
  });

  it('returns an error for an invalid URL', () => {
    const { values, error } = parseAllowedOriginsCsv('not-a-url');
    expect(values).toEqual([]);
    expect(error).toMatch(/Invalid URL: not-a-url/);
  });

  it('returns an error for a non-http(s) scheme', () => {
    const { values, error } = parseAllowedOriginsCsv('ftp://example.com');
    expect(values).toEqual([]);
    expect(error).toMatch(/Must be http or https: ftp:\/\/example\.com/);
  });

  it('reports the first invalid entry when multiple are present', () => {
    const { values, error } = parseAllowedOriginsCsv(
      'http://ok.example, javascript:alert(1), https://also-ok.example'
    );
    expect(values).toEqual([]);
    expect(error).toMatch(/Must be http or https: javascript:alert\(1\)/);
  });
});
