---
# Google Scholar only reads citation_pdf_url when the PDF sits in the same
# directory as the landing page, so keep url next to pdf under /papers/.
# Keep url lowercase: Netlify serves it at /papers/filename (lowercase, no .html).
title: "Paper title exactly as printed in the PDF"
date: {{ .Date }}
url: "/papers/filename.html"
pdf: "/papers/FILENAME.pdf"
authors:
  - "Full Name"
venue: "Full conference or journal name, or Preprint"
venue_type: "conference" # conference, journal or preprint
abstract: "Complete abstract, word for word as in the paper."
# arxiv: "https://arxiv.org/abs/XXXX.XXXXX"
---
