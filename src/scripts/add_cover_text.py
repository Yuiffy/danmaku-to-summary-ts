"""Add title/subtitle text to a cover image.

Usage:
    python src/scripts/add_cover_text.py <image_path> <title> <subtitle> <output_path>
"""
import argparse

from cover_generator import CoverGenerator


def main() -> None:
    parser = argparse.ArgumentParser(description="Add text to a cover image")
    parser.add_argument("image_path", help="Input cover image path")
    parser.add_argument("title", help="Title text")
    parser.add_argument("subtitle", help="Subtitle text")
    parser.add_argument("output_path", help="Output image path")
    args = parser.parse_args()

    generator = CoverGenerator()
    generator.add_text_to_cover(
        args.image_path,
        args.title,
        args.subtitle,
        output_path=args.output_path,
    )
    print(f"OK: {args.output_path}")


if __name__ == "__main__":
    main()
