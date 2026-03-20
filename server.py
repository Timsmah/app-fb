import http.server, socketserver, os

os.chdir('/Users/timmeniere/Desktop/Claude/App facebook')

PORT = 3000
Handler = http.server.SimpleHTTPRequestHandler
Handler.log_message = lambda *a: None  # silent

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Serving at http://localhost:{PORT}', flush=True)
    httpd.serve_forever()
