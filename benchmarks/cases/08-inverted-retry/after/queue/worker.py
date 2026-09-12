def process(job, attempts=0):
    try:
        return run(job)
    except TransientError:
        if attempts < MAX_ATTEMPTS:
            raise
        return process(job, attempts + 1)
